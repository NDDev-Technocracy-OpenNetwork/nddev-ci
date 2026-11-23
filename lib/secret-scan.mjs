import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basePolicy } from "./secret-policy.mjs";

export const commitId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
export const betterleaksVersion = "1.10.1";

export function scanHistory(environment, {base, tips, excludes}) {
  if (!tips.length || ![...tips, ...excludes].every((value) => commitId.test(value)) ||
      (base !== null && !commitId.test(base)))
    throw new Error("Secret scanning needs exact commit identities.");
  const workspace = realpathSync(environment.GITHUB_WORKSPACE);
  const policy = basePolicy(workspace, base, environment);
  try {
    const gitDirectory = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: workspace, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const env = {...environment, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_GRAFT_FILE: "/dev/null", GIT_DIR: gitDirectory, GIT_WORK_TREE: policy.directory,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1"};
    for (const name of Object.keys(env))
      if (/^(BETTERLEAKS_CONFIG|GITLEAKS_CONFIG)/.test(name) ||
          ["GH_TOKEN", "GITHUB_TOKEN", "INPUT_GITHUB-TOKEN", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
            "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"].includes(name)) delete env[name];
    const log = ["--diff-merges=first-parent", ...tips, ...excludes.map((oid) => "^" + oid)];
    const result = spawnSync("betterleaks", [
      "git", "--no-banner", "--redact", "--ignore-gitleaks-allow", "--config", policy.config,
      "--gitleaks-ignore-path", policy.directory, "--log-opts=" + log.join(" "), ".",
    ], {cwd: policy.directory, env, stdio: "inherit"});
    if (result.error || result.status !== 0) throw new Error("The change secret scan failed.");
  } finally {
    policy.cleanup();
  }
}
