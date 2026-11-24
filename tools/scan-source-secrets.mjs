#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { betterleaksVersion, commitId } from "../lib/secret-scan.mjs";
import { basePolicy } from "../lib/secret-policy.mjs";

const maximumBytes = 16 * 1024 * 1024;
const findingExit = 12;
const gitEnvironment = {
  ...process.env,
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LITERAL_PATHSPECS: "1",
};

function git(cwd, args, optional = false) {
  const result = spawnSync("git", args, {
    cwd, env: gitEnvironment, encoding: "utf8", maxBuffer: maximumBytes, timeout: 15000,
  });
  if (result.status !== 0 || result.error) {
    if (optional) return null;
    throw new Error("The local secret scan could not read the Git source.");
  }
  return result.stdout;
}

function revision(cwd, ref) {
  const oid = git(cwd, ["rev-parse", "--verify", ref], true)?.trim();
  return oid && commitId.test(oid) ? oid : null;
}

function changedLines(cwd, base, file) {
  if (!base || git(cwd, ["cat-file", "-e", base + ":" + file], true) === null) {
    return [[1, Number.MAX_SAFE_INTEGER]];
  }
  const diff = git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", base, "--", file]);
  return Array.from(diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm), (match) => {
    const first = Number(match[1]);
    return [first, first + Number(match[2] ?? 1) - 1];
  }).filter(([first, last]) => first <= last);
}

function names(cwd, base, explicit) {
  if (explicit.length) return new Set(explicit.map((name) => path.relative(cwd, path.resolve(name))));
  const tracked = base
    ? git(cwd, ["diff", "--name-only", "--no-ext-diff", "--no-renames", "--diff-filter=ACMRT", "-z", base])
    : git(cwd, ["ls-files", "--cached", "-z"]);
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return new Set((tracked + untracked).split("\0").filter(Boolean));
}

function source(cwd, file) {
  if (!file || file === ".." || file.startsWith(".." + path.sep) || path.isAbsolute(file)) {
    throw new Error("The local secret scan needs a path in the worktree.");
  }
  let actual;
  try {
    actual = realpathSync(path.join(cwd, file));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (actual !== path.join(cwd, file)) return null;
  const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size > maximumBytes) throw new Error("Source exceeds the secret scan size limit: " + file);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset);
      if (!count) throw new Error("Source changed during the secret scan: " + file);
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      throw new Error("Source changed during the secret scan: " + file);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function scan(policy, environment, file, contents) {
  const result = spawnSync("betterleaks", [
    "stdin", "--set-attr", "path=" + file, "--no-banner", "--no-color",
    "--redact=100", "--ignore-gitleaks-allow", "--log-level", "error",
    "--config", policy.config, "--gitleaks-ignore-path", policy.directory,
    "--exit-code", String(findingExit), "--report-format", "json", "--report-path", "-",
  ], {
    cwd: policy.directory, env: environment, input: contents,
    encoding: "utf8", maxBuffer: maximumBytes, timeout: 15000,
  });
  if (result.status === 0 && !result.error) return [];
  if (result.status !== findingExit || result.error) {
    throw new Error("Betterleaks could not scan " + file + ".");
  }
  // The scanner report can contain sensitive fields. Only publish the rule and the location.
  return JSON.parse(result.stdout).map(({ RuleID, StartLine, EndLine }) => ({
    rule: RuleID, first: StartLine, last: EndLine,
  }));
}

try {
  const cwd = realpathSync(git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim());
  const head = revision(cwd, "HEAD");
  const tracking = revision(cwd, "refs/remotes/origin/dev");
  const published = head && tracking ? git(cwd, ["merge-base", head, tracking], true)?.trim() : null;
  const policyBase = published && commitId.test(published) ? published : null;
  const baseline = policyBase ?? head;
  const files = names(cwd, baseline, process.argv.slice(2));
  if (files.size) {
    const environment = { ...process.env, GITHUB_WORKSPACE: cwd, RUNNER_TEMP: tmpdir() };
    for (const name of Object.keys(environment)) {
      if (/^(BETTERLEAKS_CONFIG|GITLEAKS_CONFIG|GIT_|GH_TOKEN$|GITHUB_TOKEN$)/.test(name)) delete environment[name];
    }
    const version = spawnSync("betterleaks", ["version"], { env: environment, encoding: "utf8" });
    if (version.status !== 0 || version.stdout.trim() !== betterleaksVersion) {
      throw new Error("The local source scan requires Betterleaks " + betterleaksVersion + ".");
    }
    const policy = basePolicy(cwd, policyBase, environment);
    try {
      for (const file of files) {
        const ranges = changedLines(cwd, baseline, file);
        if (!ranges.length) continue;
        const data = source(cwd, file);
        if (!data?.length) continue;
        for (const finding of scan(policy, environment, file, data)) {
          if (ranges.some(([first, last]) => finding.first <= last && finding.last >= first)) {
            console.error(JSON.stringify({ file, line: finding.first, rule: finding.rule }));
            process.exitCode = 1;
          }
        }
      }
    } finally {
      policy.cleanup();
    }
  }
} catch (error) {
  console.error(error instanceof SyntaxError ? "The local secret scan could not read the detector report." : error.message);
  process.exitCode = 1;
}
