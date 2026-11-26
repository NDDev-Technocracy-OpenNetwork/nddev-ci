// Verifies Dockerfile external base images and syntax directives against NDDEV_CI_REGISTRY_SNAPSHOT.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkDockerfileImages, loadRegistrySnapshot } from "../../lib/registry-resolve.mjs";
import { ActionError } from "../../lib/release-asset.mjs";

export function parseBuildArgs(text) {
  const args = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) args[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return args;
}

export function main(environment = process.env) {
  const snapshot = loadRegistrySnapshot(environment);
  if (!snapshot) return { checked: [], violations: [] };
  const workspace = environment.GITHUB_WORKSPACE || process.cwd();
  const dockerfile = (environment.INPUT_DOCKERFILE || "Dockerfile").trim();
  const fullPath = path.resolve(workspace, dockerfile);
  const rel = path.relative(path.resolve(workspace), fullPath);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ActionError("Dockerfile path must stay inside the workspace.");
  }
  const content = readFileSync(fullPath, "utf8");
  const buildArgs = parseBuildArgs(environment.INPUT_BUILD_ARGS);
  const result = checkDockerfileImages(snapshot, content, buildArgs);
  for (const violation of result.violations) {
    console.error(`::error::Dockerfile line ${violation.line} (${violation.reference}): ${violation.reason}`);
  }
  if (result.violations.length > 0) {
    throw new ActionError(`Dockerfile contains ${result.violations.length} image reference(s) outside the registry snapshot.`);
  }
  console.log(`Verified ${result.checked.length} Dockerfile image reference(s) against registry snapshot.`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof ActionError ? error.message : error.message}`);
    process.exitCode = 1;
  }
}
