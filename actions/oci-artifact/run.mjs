import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultRegistryUrl,
  inspectOciArtifact,
  pullOciArtifacts,
  pushOciArtifact,
  validateOciArtifact,
} from "../../lib/oci-artifacts.mjs";

function writeOutputs(file, entries) {
  if (!file) return;
  const lines = Object.entries(entries)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const text = String(value);
      if (/[\r\n]/.test(text)) throw new Error(`Output ${key} cannot span multiple lines.`);
      return `${key}=${text}`;
    });
  if (lines.length) appendFileSync(file, `${lines.join("\n")}\n`);
}

export async function main(environment = process.env) {
  const input = (name) => (environment[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const mode = input("mode") || "push";
  const name = input("name");
  if (!name) throw new Error("An artifact name or digest is required.");
  const repository = environment.GITHUB_REPOSITORY ?? "";
  const sha = environment.GITHUB_SHA ?? "";
  const branch = environment.GITHUB_REF_NAME ?? "";
  const runId = Number(environment.GITHUB_RUN_ID ?? 0);
  const runAttempt = Number(environment.GITHUB_RUN_ATTEMPT ?? 0);
  const token = input("github-token");
  const actor = environment.GITHUB_ACTOR || "x-access-token";
  const registryUrl = input("registry-url") || environment.NDDEV_CI_OCI_REGISTRY_URL || defaultRegistryUrl;
  const outputFile = environment.GITHUB_OUTPUT;

  if (mode === "push") {
    const cwd = environment.GITHUB_WORKSPACE || process.cwd();
    const allowedRoots = [cwd, environment.RUNNER_TEMP].filter(Boolean);
    const result = await pushOciArtifact({
      repository,
      sha,
      branch,
      runId,
      runAttempt,
      name,
      part: input("part"),
      pathsText: environment.INPUT_PATH ?? "",
      cwd,
      allowedRoots,
      token,
      actor,
      registryUrl,
    });
    writeOutputs(outputFile, { digest: result.digest, reference: result.reference, part: input("part") });
    console.log(
      result.bundled
        ? `Pushed OCI artifact ${name} (${result.files.length} files bundled in ${result.archiveTitle}): ${result.reference}`
        : `Pushed OCI artifact ${name} (${result.files.length} files): ${result.reference}`,
    );
    return result;
  }

  if (mode === "validate") {
    const cwd = environment.GITHUB_WORKSPACE || process.cwd();
    const allowedRoots = [cwd, environment.RUNNER_TEMP].filter(Boolean);
    const result = await validateOciArtifact({
      name,
      pathsText: environment.INPUT_PATH ?? "",
      cwd,
      allowedRoots,
    });
    writeOutputs(outputFile, { part: input("part") });
    console.log(
      result.bundled
        ? `Validated OCI artifact ${name} (${result.files.length} files, will bundle as ${name}.tar.gz).`
        : `Validated OCI artifact ${name} (${result.files.length} files).`,
    );
    return result;
  }

  if (mode === "verify") {
    const result = await inspectOciArtifact({
      repository,
      sha,
      branch,
      runId,
      runAttempt,
      nameOrDigest: name,
      token,
      actor,
      registryUrl,
      retryReads: true,
    });
    writeOutputs(outputFile, { digest: result.digest, reference: result.reference, part: result.part });
    console.log(`Verified OCI artifact ${result.name}: ${result.reference}`);
    return result;
  }

  if (mode === "pull") {
    const temp = environment.RUNNER_TEMP;
    if (!temp) throw new Error("Pulling an OCI artifact requires RUNNER_TEMP.");
    const root = realpathSync(temp);
    const rawTarget = input("directory");
    if (!rawTarget) throw new Error("Pulling an OCI artifact requires a destination directory.");
    const resolvedTemp = path.resolve(temp);
    const normalized = path.isAbsolute(rawTarget) && (rawTarget === resolvedTemp || rawTarget.startsWith(resolvedTemp + path.sep))
      ? path.join(root, path.relative(resolvedTemp, rawTarget))
      : rawTarget;
    const directory = path.resolve(root, normalized);
    const relative = path.relative(root, directory);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || existsSync(directory))
      throw new Error("OCI artifact destination must be a new path inside RUNNER_TEMP.");
    mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    const result = await pullOciArtifacts({
      repository,
      sha,
      branch: "",
      runId,
      runAttempt,
      names: [name],
      destination: directory,
      topLevelOnly: false,
      token,
      actor,
      registryUrl,
      retryReads: true,
    });
    const first = result.artifacts[0];
    writeOutputs(outputFile, { digest: first.digest, reference: first.reference, directory });
    console.log(`Pulled OCI artifact ${first.name} (${result.files.length} files): ${first.reference}`);
    return result;
  }

  throw new Error(`Unknown OCI artifact mode: ${mode}`);
}

export function classifyOciFailure(mode, message) {
  const text = String(message ?? "");
  if (/too many files/i.test(text)) return "artifact-too-many-files";
  if (/no files matched/i.test(text)) return "artifact-missing";
  if (/exceed|oversized/i.test(text)) return "artifact-oversized";
  if (mode === "verify") return "artifact-verify-failed";
  if (mode === "pull") return "artifact-download-failed";
  return "artifact-upload-failed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const mode = (process.env.INPUT_MODE ?? "").trim() || "push";
    writeOutputs(process.env.GITHUB_OUTPUT, {
      "failure-reason": classifyOciFailure(mode, error.message),
      ...(error?.upstreamReason ? { "upstream-reason": error.upstreamReason } : {}),
    });
    console.error(`::error::${String(error.message).replace(/[\r\n%]/g, " ")}`);
    process.exitCode = 1;
  });
}
