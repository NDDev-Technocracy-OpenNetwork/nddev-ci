import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildArchiveArgs, buildRunArgs, parseStringArrayInput, validateShardConfig } from "../../lib/nextest-shards.mjs";
import { runProjectCommand } from "../../lib/project-command.mjs";
import { hostedLabels } from "../../lib/runner-profile.mjs";
import { sanitizeProjectEnv } from "../../lib/step-receipts.mjs";

function resolveWorkdir(workspace, relative) {
  const rel = String(relative || ".").trim() || ".";
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    throw new Error("working-directory must stay inside the workspace.");
  }
  const full = path.resolve(workspace, rel);
  const root = path.resolve(workspace);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
    throw new Error("working-directory must stay inside the workspace.");
  }
  return full;
}

export async function runNextestStep(environment = process.env) {
  const mode = (environment.INPUT_MODE || "").trim();
  const output = environment.GITHUB_OUTPUT || "";
  const workspace = environment.GITHUB_WORKSPACE || process.cwd();
  const cwd = resolveWorkdir(workspace, environment["INPUT_WORKING-DIRECTORY"]);

  if (mode === "plan") {
    const isPrivate = (environment["INPUT_PRIVATE-REPOSITORY"] || "true").trim() === "true";
    const hosted = (environment["INPUT_HOSTED-RUNNER"] || "").trim();
    if (!isPrivate && hosted && !hostedLabels.linux.includes(hosted)) {
      throw new Error("hosted-runner must be a GitHub-hosted Linux label of this workflow.");
    }
    const config = validateShardConfig({
      shards: environment.INPUT_SHARDS,
      strategy: environment["INPUT_PARTITION-STRATEGY"],
      profile: environment["INPUT_NEXTEST-PROFILE"],
    });
    parseStringArrayInput(environment.INPUT_ARGUMENTS, "arguments");
    if (output) appendFileSync(output, `matrix=${JSON.stringify(config.matrix)}\n`);
    return 0;
  }

  const cleanEnv = sanitizeProjectEnv(environment);
  const extraArgs = parseStringArrayInput(environment.INPUT_ARGUMENTS, "arguments");
  const archiveFile = (environment["INPUT_ARCHIVE-FILE"] || "").trim();

  if (mode === "archive") {
    mkdirSync(path.dirname(archiveFile), { recursive: true });
    const argv = buildArchiveArgs({ archiveFile, extraArgs });
    return runProjectCommand("cargo", argv, { cwd, environment: cleanEnv, output });
  }

  if (mode === "run") {
    if (!existsSync(archiveFile)) {
      throw new Error(`Nextest archive is missing at ${archiveFile}.`);
    }
    const extractTo = (environment["INPUT_EXTRACT-TO"] || "").trim();
    if (extractTo) mkdirSync(extractTo, { recursive: true });
    const argv = buildRunArgs({
      archiveFile,
      extractTo,
      partition: (environment.INPUT_PARTITION || "").trim(),
      profile: (environment["INPUT_NEXTEST-PROFILE"] || "").trim(),
      extraArgs,
    });
    return runProjectCommand("cargo", argv, { cwd, environment: cleanEnv, output });
  }

  throw new Error('mode must be "plan", "archive" or "run".');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runNextestStep();
}
