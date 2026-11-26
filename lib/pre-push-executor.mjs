import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { maximumSnapshotBytes, verifyRegistrySnapshot } from "./registry-snapshot.mjs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { prePushRegistryInput, requireRegistryLockPath } from "./pre-push-registry-input.mjs";

const identity = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const repositoryName = /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/;
const hostName = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;
const refName = /^refs\/contour\/pre-push\/[a-f0-9-]{36}$/;
const maximumBundleBytes = 256 * 1024 * 1024;
const managedSlotRetryMs = 5_000;
const managedSlotProgressMs = 30_000;
const slotUnavailable = "no managed pre-push slot is available";
const maximumLockBytes = 1024 * 1024;
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

function managedPublishedBase(tip, repository) {
  const remotes = git(["remote"], { optional: true })?.split("\n") ?? [];
  for (const remote of remotes) {
    if (!hostName.test(remote)) continue;
    const url = git(["remote", "get-url", "--push", remote], { optional: true });
    const pushRepository = url?.match(
      /^(?:git@github\.com:|(?:https|git):\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/i,
    )?.[1].replace(/\.git$/i, "");
    if (pushRepository?.toLowerCase() !== repository.toLowerCase()) continue;
    const base = publishedBase(tip, remote);
    if (base === tip) return git(["rev-parse", "--verify", tip + "^"], { optional: true });
    if (base) return base;
  }
  return null;
}

async function bundlePrerequisites(bundle, oidLength) {
  const stream = createReadStream(bundle);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const commits = new Set();
  try {
    for await (const line of lines) {
      if (line === "") return [...commits];
      if (line.startsWith("-")) {
        const commit = line.slice(1, oidLength + 1);
        if (line[oidLength + 1] !== " " || commit.length !== oidLength || !identity.test(commit)) {
          throw new Error("Invalid Git bundle prerequisite.");
        }
        commits.add(commit);
      }
    }
    throw new Error("The Git bundle header is incomplete.");
  } finally {
    lines.close();
    stream.destroy();
  }
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

async function readAdmission(stderr) {
  // The fixed controller command reports admission on stderr. Builds run in a separate unit.
  let unavailable = false;
  for await (const line of createInterface({ input: stderr, crlfDelay: Infinity })) {
    if (line === slotUnavailable) unavailable = true;
    else process.stderr.write(line + "\n");
  }
  return unavailable;
}

function closedInput(error) {
  return ["EPIPE", "ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"].includes(error?.code);
}

async function sendAttempt(host, tip, revisions, { argv, header, snapshot }) {
  const producer = spawn("git", ["bundle", "create", "-", ...revisions], {
    env: gitEnvironment, stdio: ["ignore", "pipe", "inherit"],
  });
  const executor = spawn("ssh", [
    "-T", "-oBatchMode=yes", "-oConnectTimeout=15", "--", host,
    ...argv,
  ], { stdio: ["pipe", "inherit", header ? "pipe" : "inherit"] });
  const sent = exit(producer);
  const checked = exit(executor);
  const admission = header ? readAdmission(executor.stderr) : Promise.resolve(false);
  const transfer = pipeline(
    producer.stdout, boundedBundle(), async function* (chunks) {
      if (header) yield header;
      if (snapshot) yield snapshot;
      yield* chunks;
    }, executor.stdin,
  ).catch(error => {
    producer.kill();
    if (!header || !closedInput(error)) executor.kill();
    return error;
  });
  try {
    const [packed, verified, unavailable, error] = await Promise.all([sent, checked, admission, transfer]);
    if (unavailable && verified === 1 && (!error || closedInput(error))) return false;
    if (error) throw error;
    if (packed !== 0 || verified !== 0) throw new Error("The build host did not verify " + tip + ".");
    return true;
  } catch (error) {
    producer.kill();
    executor.kill();
    await Promise.allSettled([sent, checked, admission, transfer]);
    throw error;
  }
}

async function sendOne(host, tip, base, command) {
  const run = randomUUID();
  const ref = "refs/contour/pre-push/" + run;
  git(["update-ref", ref, tip, "0".repeat(tip.length)]);
  try {
    const revisions = [ref];
    if (base && base !== tip) revisions.push("^" + base);
    const request = command(run, ref);
    if (await sendAttempt(host, tip, revisions, request)) return;
    const waitingSince = performance.now();
    let nextProgress = waitingSince + managedSlotProgressMs;
    process.stderr.write("Waiting for a managed pre-push slot on " + host + ".\n");
    for (;;) {
      await delay(managedSlotRetryMs);
      if (await sendAttempt(host, tip, revisions, request)) return;
      const now = performance.now();
      if (now >= nextProgress) {
        const elapsedSeconds = Math.floor((now - waitingSince) / 1000);
        process.stderr.write("Still waiting for a managed pre-push slot on " + host
          + " after " + elapsedSeconds + " seconds.\n");
        nextProgress = now + managedSlotProgressMs;
      }
    }
  } finally {
    git(["update-ref", "-d", ref, tip]);
  }
}

function publishingTips(host, repository, input) {
  if (!hostName.test(host) || !repositoryName.test(repository)) {
    throw new Error("A managed build host and GitHub repository are required.");
  }
  return [...publishingBranches(input)].filter(tip =>
    git(["ls-tree", tip, "--", "justfile", "Justfile", ".justfile", ".Justfile"]));
}

export async function send(host, repository, remote, input) {
  for (const tip of publishingTips(host, repository, input)) {
    const base = publishedBase(tip, remote);
    await sendOne(host, tip, base, (run, ref) => ({
      argv: [
        "/usr/local/bin/contour-agent-build", "pre-push-" + run, "--",
        "/usr/bin/env", "node", receiver, "--receive", repository, tip, ref, base ?? "none",
      ],
    }));
  }
}

function readRegistryLock(tip, lock, options) {
  const entry = git(["ls-tree", tip, "--", lock], options);
  if (!/^100(?:644|755) blob /.test(entry)) {
    throw new Error("The candidate registry lock is not a regular Git file.");
  }
  const object = tip + ":" + lock;
  const size = Number(git(["cat-file", "-s", object], options));
  if (!Number.isSafeInteger(size) || size < 1 || size > maximumLockBytes) {
    throw new Error("The candidate registry lock is missing or oversized.");
  }
  return git(["cat-file", "blob", object], options);
}

function candidateRegistry(tip, lock) {
  const bytes = readRegistryLock(tip, lock);
  let selection;
  try {
    selection = JSON.parse(bytes);
  } catch {
    throw new Error("The candidate registry lock is not valid JSON.");
  }
  if (selection?.schema_version !== 1 ||
      !/^[0-9a-f]{40}$/.test(selection.registry_commit ?? "")) {
    throw new Error("The candidate registry lock has no supported registry commit.");
  }
  return selection.registry_commit;
}

function absoluteExecutable(file) {
  return /^\/[A-Za-z0-9_./-]+$/.test(file) && path.posix.normalize(file) === file;
}

function protectedSnapshot(resolver, repository, commit) {
  const result = spawnSync(resolver, [repository, commit], {
    stdio: ["ignore", "pipe", "inherit"], maxBuffer: maximumSnapshotBytes, timeout: 60000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Could not read the selected protected registry snapshot.");
  }
  const bytes = result.stdout;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  verifyRegistrySnapshot(bytes, commit, sha256);
  return { bytes, identity: { commit, sha256, bytes: bytes.length } };
}

export async function sendManaged(host, executable, repository, lock, resolver, input) {
  // OpenSSH joins remote arguments into a shell command; the executable is one literal token.
  if (!absoluteExecutable(executable)) {
    throw new Error("The managed build executor needs a literal absolute path.");
  }
  if (lock !== "none") {
    requireRegistryLockPath(lock);
    if (!absoluteExecutable(resolver)) {
      throw new Error("A protected registry lock needs a trusted snapshot resolver.");
    }
  } else if (resolver !== "none") {
    throw new Error("A snapshot resolver needs a protected registry lock.");
  }
  for (const tip of publishingTips(host, repository, input)) {
    const registry = lock === "none" ? null : protectedSnapshot(resolver, repository, candidateRegistry(tip, lock));
    // The executor can be admitted as a fixed command. Source and registry data stay on stdin.
    await sendOne(host, tip, managedPublishedBase(tip, repository), (_run, ref) => ({
      argv: [executable],
      header: Buffer.from(JSON.stringify({
        schema_version: 1,
        repository,
        commit: tip,
        transfer_ref: ref,
        registry: registry?.identity ?? null,
      }) + "\n"),
      snapshot: registry?.bytes,
    }));
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
    if (git(["bundle", "list-heads", bundle]) !== tip + " " + ref) {
      throw new Error("The transferred source does not match " + tip + ".");
    }
    mkdirSync(work);
    const options = { cwd: work };
    git(["init", "--quiet", "--object-format=" + (tip.length === 64 ? "sha256" : "sha1")], options);
    git(["remote", "add", "origin", "git@github.com:" + repository + ".git"], options);
    const prerequisites = base === "none" ? await bundlePrerequisites(bundle, tip.length)
      : base === tip ? [] : [base];
    if (prerequisites.length > 0) {
      git(["fetch", "--quiet", "--no-tags", "origin", ...prerequisites], options);
      const published = prerequisites.length === 1
        ? prerequisites[0] : git(["merge-base", "--independent", ...prerequisites], options);
      if (!identity.test(published)) throw new Error("The source bundle has no single published base.");
      git(["update-ref", "refs/remotes/origin/dev", published], options);
    }
    git(["fetch", "--quiet", "--no-tags", bundle, ref], options);
    git(["checkout", "--quiet", "--detach", tip], options);
    const registry = prePushRegistryInput(process.env, lock => readRegistryLock(tip, lock, options), temporary);
    return verify(work, { ...process.env, ...registry, CI: "true", GITHUB_SHA: tip, TMPDIR: temporary });
  } finally {
    rmSync(root, { recursive: true });
  }
}
