import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { scannerPolicy } from "./security-policy.mjs";

const names = [
  ".betterleaks.toml", ".gitleaks.toml", ".betterleaksignore", ".gitleaksignore",
];
function git(workspace, args) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(execFileSync("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: workspace, maxBuffer: 64 * 1024,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch { throw new Error("The trusted secret policy is unavailable or exceeds its bound."); }
}
function policyObjects(workspace, base) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(base ?? ""))
    throw new Error("The secret policy needs an exact base commit.");
  return git(workspace, ["ls-tree", "-z", base, "--", ...names]).split("\0").filter(Boolean).map((line) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/.exec(line);
    if (!match || !names.includes(match[3])) throw new Error("The base secret policy must contain regular files.");
    return { name: match[3], object: match[2] };
  });
}
export function basePolicy(workspace, base, environment) {
  const files = policyObjects(workspace, base);
  const selected = names.slice(0, 2).map((name) => files.find((f) => f.name === name)).find(Boolean);
  const contents = selected ? git(workspace, ["cat-file", "blob", selected.object]) : "[extend]\nuseDefault = true\n";
  // An extension must not read mutable checkout files or fetch another policy at scan time.
  try {
    execFileSync("python3", ["-c", "import sys,tomllib; p=tomllib.loads(sys.stdin.read()); e=p.get('extend',{}); sys.exit(1 if e.get('path') or e.get('url') else 0)"], {
      input: contents, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024,
    });
  } catch { throw new Error("The base secret policy must be valid self-contained TOML; useDefault is supported."); }
  const policy = scannerPolicy(environment, "betterleaks.toml", contents);
  try {
    for (const file of files.filter((f) => f.name.endsWith("ignore")))
      writeFileSync(path.join(policy.directory, file.name), git(workspace, ["cat-file", "blob", file.object]), { flag: "wx", mode: 0o400 });
    return policy;
  } catch (error) { policy.cleanup(); throw error; }
}
