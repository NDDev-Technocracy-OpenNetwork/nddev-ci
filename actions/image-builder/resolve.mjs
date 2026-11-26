// Resolves Buildx and BuildKit versions for actions/image-builder.
// Managed runners verify against NDDEV_CI_REGISTRY_SNAPSHOT when present and never read hosted pins.
// Hosted runners take explicit caller inputs, validate against any snapshot, or fall back to hosted compatibility pins.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostedImageBuilderPin } from "../../lib/hosted-compat-pins.mjs";
import {
  checkImageReference,
  loadRegistrySnapshot,
  resolveToolchain,
} from "../../lib/registry-resolve.mjs";
import { ActionError } from "../../lib/release-asset.mjs";

const buildxVersionPattern = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const buildkitImagePattern = /^[a-z0-9./_-]+:v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)@sha256:[0-9a-f]{64}$/;

export function resolveHostedImageBuilder(environment = process.env) {
  const snapshot = loadRegistrySnapshot(environment);
  const explicitBuildx = (environment.INPUT_BUILDX_VERSION ?? "").trim();
  const explicitBuildkit = (environment.INPUT_BUILDKIT_IMAGE ?? "").trim();
  const fallback = hostedImageBuilderPin(environment);

  const buildxRaw = explicitBuildx || fallback.buildxVersion;
  if (!buildxVersionPattern.test(buildxRaw)) {
    throw new ActionError(`Buildx version must be an exact semantic version: ${buildxRaw}.`);
  }
  const buildxVersion = buildxRaw.startsWith("v") ? buildxRaw : `v${buildxRaw}`;
  const buildkitImage = explicitBuildkit || fallback.buildkitImage;
  if (!buildkitImagePattern.test(buildkitImage)) {
    throw new ActionError("BuildKit image must be pinned by exact version tag and @sha256 digest.");
  }

  if (snapshot) {
    resolveToolchain(snapshot, "buildx", buildxVersion.slice(1));
    checkImageReference(snapshot, buildkitImage);
  }
  return { buildxVersion, buildkitImage };
}

export function verifyManagedBuildx(environment = process.env) {
  const snapshot = loadRegistrySnapshot(environment);
  if (!snapshot) return { checked: false };
  const result = spawnSync("docker", ["buildx", "version"], {
    env: environment,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 65536,
  });
  if (result.error || result.status !== 0) {
    throw new ActionError("Could not read managed docker buildx version.");
  }
  const measured = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/\bv?(\d+\.\d+\.\d+)\b/)?.[1];
  if (!measured) throw new ActionError("Managed docker buildx reported no semantic version.");
  resolveToolchain(snapshot, "buildx", measured);
  return { checked: true, version: measured };
}

export function main(mode = process.argv[2], environment = process.env) {
  if (mode === "managed") {
    const res = verifyManagedBuildx(environment);
    if (res.checked) console.log(`Verified managed buildx ${res.version} against registry snapshot.`);
    return res;
  }
  if (mode === "hosted") {
    const resolved = resolveHostedImageBuilder(environment);
    if (environment.GITHUB_OUTPUT) {
      appendFileSync(
        environment.GITHUB_OUTPUT,
        `buildx-version=${resolved.buildxVersion}\nbuildkit-image=${resolved.buildkitImage}\n`,
      );
    }
    return resolved;
  }
  throw new ActionError(`Unknown image-builder resolver mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof ActionError ? error.message : "Image builder resolution failed."}`);
    process.exitCode = 1;
  }
}
