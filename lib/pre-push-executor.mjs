import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prePushRegistryInput } from "./pre-push-registry-input.mjs";

const identity = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const repositoryName = /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/;
const hostName = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;
const refName = /^refs\/contour\/pre-push\/[a-f0-9-]{36}$/;
const maximumBundleBytes = 256 * 1024 * 1024;
const receiver = "/usr/local/libexec/contour/pre-push/verify-before-push.mjs";
const gitEnvironment = {
  ...process.env,
  GIT_GRAFT_FILE: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function git(args, { cwd, optional = false } = {}) {
  const result = spawnSync("git", args, { cwd, env: gitEnvironment, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    if (optional) return null;
    process.stderr.write(result.stderr ?? "");
    throw new Error("Could not prepare the exact Git source for pre-push verification.");
  }
  return result.stdout.trim();
}

export function publishingBranches(input) {
  const updates = new Set();
  for (const line of input.trim().split("\n").filter(Boolean)) {
    const fields = line.split(/\s+/);
    const [, tip, destination, previous] = fields;
    if (fields.length !== 4 || !identity.test(tip) || !identity.test(previous) ||
        tip.length !== previous.length || !destination.startsWith("refs/")) {
      throw new Error("Invalid pre-push ref update.");
    }
    if (destination.startsWith("refs/heads/") && !/^0+$/.test(tip) && tip !== previous) {
      updates.add(tip);
    }
  }
  return updates;
}

function publishedBase(tip, remote) {
  if (!hostName.test(remote)) return null;
  const tracking = git(["rev-parse", "--verify", "refs/remotes/" + remote + "/dev"], { optional: true });
  return tracking && identity.test(tracking)
    ? git(["merge-base", tip, tracking], { optional: true })
    : null;
}

function boundedBundle() {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes <= maximumBundleBytes ? null : new Error("The source bundle exceeds 256 MiB."), chunk);
    },
  });
}

async function exit(child) {
  const [code] = await once(child, "close");
  return code;
}

async function sendOne(host, repository, tip, base) {
  const run = randomUUID();
  const ref = "refs/contour/pre-push/" + run;
  git(["update-ref", ref, tip, "0".repeat(tip.length)]);
  try {
    const revisions = [ref];
    if (base && base !== tip) revisions.push("^" + base);
    const producer = spawn("git", ["bundle", "create", "-", ...revisions], {
      env: gitEnvironment, stdio: ["ignore", "pipe", "inherit"],
    });
    const executor = spawn("ssh", [
      "-T", "-oBatchMode=yes", "-oConnectTimeout=15", "--", host,
      "/usr/local/bin/contour-agent-build", "pre-push-" + run, "--",
      "/usr/bin/env", "node", receiver, "--receive", repository, tip, ref, base ?? "none",
    ], { stdio: ["pipe", "inherit", "inherit"] });
    const sent = exit(producer);
    const checked = exit(executor);
    try {
      const [packed, verified] = await Promise.all([
        sent, checked, pipeline(producer.stdout, boundedBundle(), executor.stdin),
      ]);
      if (packed !== 0 || verified !== 0) throw new Error("The build host did not verify " + tip + ".");
    } catch (error) {
      producer.kill();
      executor.kill();
      await Promise.allSettled([sent, checked]);
      throw error;
    }
  } finally {
    git(["update-ref", "-d", ref, tip]);
  }
}

export async function send(host, repository, remote, input) {
  if (!hostName.test(host) || !repositoryName.test(repository)) {
    throw new Error("A managed build host and GitHub repository are required.");
  }
  for (const tip of publishingBranches(input)) {
    if (!git(["ls-tree", tip, "--", "justfile", "Justfile", ".justfile", ".Justfile"])) continue;
    const base = publishedBase(tip, remote);
    await sendOne(host, repository, tip, base);
  }
}

export async function receive(repository, tip, ref, base, verify) {
  if (!repositoryName.test(repository) || !identity.test(tip) || !refName.test(ref) ||
      !(base === "none" || (identity.test(base) && base.length === tip.length))) {
    throw new Error("Invalid Git source identity for pre-push verification.");
  }
  const root = mkdtempSync(path.join(process.cwd(), "source."));
  try {
    const bundle = path.join(root, "source.bundle");
    const work = path.join(root, "worktree");
    const temporary = path.join(root, "tmp");
    mkdirSync(temporary, { mode: 0o700 });
    await pipeline(process.stdin, boundedBundle(), createWriteStream(bundle, { flags: "wx", mode: 0o600 }));
    if (git(["bundle", "list-heads", bundle, ref]) !== tip + " " + ref) {
      throw new Error("The transferred source does not match " + tip + ".");
    }
    mkdirSync(work);
    const options = { cwd: work };
    git(["init", "--quiet", "--object-format=" + (tip.length === 64 ? "sha256" : "sha1")], options);
    git(["remote", "add", "origin", "git@github.com:" + repository + ".git"], options);
    if (base !== "none" && base !== tip) {
      git(["fetch", "--quiet", "--no-tags", "origin", base], options);
      git(["update-ref", "refs/remotes/origin/dev", base], options);
    }
    git(["fetch", "--quiet", "--no-tags", bundle, ref], options);
    git(["checkout", "--quiet", "--detach", tip], options);
    const registry = prePushRegistryInput(process.env, (lock) => {
      const entry = git(["ls-tree", tip, "--", lock], options);
      if (!/^100(?:644|755) blob /.test(entry)) throw new Error("The candidate registry lock is not a regular Git file.");
      return git(["cat-file", "blob", tip + ":" + lock], options);
    }, temporary);
    return verify(work, { ...process.env, ...registry, CI: "true", GITHUB_SHA: tip, TMPDIR: temporary });
  } finally {
    rmSync(root, { recursive: true });
  }
}
