#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { betterleaksVersion, commitId, scanHistory } from "../lib/secret-scan.mjs";

const zero = (oid) => /^0+$/.test(oid);
function git(args, {optional = false} = {}) {
  try {
    return execFileSync("git", ["--no-replace-objects", ...args], {
      encoding: "utf8", maxBuffer: 64 * 1024, timeout: 15000,
      env: {...process.env, GIT_NO_LAZY_FETCH: "1", GIT_GRAFT_FILE: "/dev/null", GIT_TERMINAL_PROMPT: "0"},
      stdio: ["pipe", "pipe", "pipe"],
    }).trimEnd();
  } catch {
    if (!optional) throw new Error("Could not read the published Git history for the pre-push scan.");
    return "";
  }
}

function changes(input) {
  const destination = new Set();
  return input.split("\n").filter(Boolean).map((line) => {
    const [source, head, ref, old, ...extra] = line.split(" ");
    if (extra.length || !commitId.test(head) || !commitId.test(old) || head.length !== old.length ||
        zero(head) !== (source === "(delete)") || (zero(head) && zero(old)) ||
        !ref?.startsWith("refs/") || destination.has(ref))
      throw new Error("Invalid Git pre-push ref update.");
    destination.add(ref);
    return {head, ref, old};
  }).filter(({head, old}) => !zero(head) && head !== old);
}

function trackedBase(remote, destination, updates) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(remote) ||
      git(["remote", "get-url", "--", remote], {optional: true}) !== destination)
    return "";
  const tracking = `refs/remotes/${remote}/`;
  const defaultRef = git(["symbolic-ref", "-q", tracking + "HEAD"], {optional: true});
  if (!defaultRef.startsWith(tracking)) return "";
  const current = updates.find(({ref, old}) => !zero(old) && ref === "refs/heads/" + defaultRef.slice(tracking.length));
  return current?.old || git(["rev-parse", "--verify", defaultRef + "^{commit}"], {optional: true});
}

function advertisedBase(destination) {
  const [base, ref] = git(["ls-remote", "--", destination, "HEAD"]).split("\t");
  if (!base) return null;
  if (!commitId.test(base) || ref !== "HEAD" ||
      git(["rev-parse", "--verify", base + "^{commit}"], {optional: true}) !== base)
    throw new Error("Fetch the published policy base before pushing.");
  return base;
}

export function main(remote, destination, input, environment = process.env) {
  if (!remote || !destination) throw new Error("The pre-push scanner needs Git's remote name and destination.");
  const updates = changes(input);
  if (!updates.length) return;

  const base = trackedBase(remote, destination, updates) || advertisedBase(destination);
  const published = new Set(base ? [base] : []);
  const tips = new Set();
  for (const {head, old, ref} of updates) {
    if (!zero(old)) published.add(old);
    if (ref.startsWith("refs/heads/")) tips.add(head);
    else {
      const commit = git(["rev-parse", "--verify", head + "^{commit}"], {optional: true});
      if (commit) tips.add(commit);
    }
  }
  const proposed = [...tips].filter((oid) => !published.has(oid));
  if (!proposed.length) return;

  let version;
  try {
    version = execFileSync("betterleaks", ["version"], {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
  } catch { throw new Error(`The local change scan requires Betterleaks ${betterleaksVersion}.`); }
  if (version !== betterleaksVersion)
    throw new Error(`The local change scan requires Betterleaks ${betterleaksVersion}.`);
  scanHistory({...environment, GITHUB_WORKSPACE: git(["rev-parse", "--show-toplevel"]), RUNNER_TEMP: tmpdir()},
    {base, tips: proposed, excludes: [...published]});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv[2], process.argv[3], readFileSync(0, "utf8")); }
  catch (error) {
    console.error(`Pre-push secret scan: ${error.message}`);
    process.exitCode = 1;
  }
}
