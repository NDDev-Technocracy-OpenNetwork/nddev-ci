// Shared Linux tool preparation and CLI helpers for merge-stops, security-tools and image-builder.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findManagedTool, resolveTool, resolveToolDigest } from "./registry-resolve.mjs";
import { ActionError } from "./release-asset.mjs";

export const sha256Pattern = /^[0-9a-f]{64}$/;
export const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function parseCallerPins(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ActionError("tool-pins must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ActionError("tool-pins must be a JSON object mapping tool names to version and sha256 pins.");
  }
  return parsed;
}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function curlToFile(url, output, headers, environment) {
  const args = [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--max-time",
    "180",
    "--max-filesize",
    "268435456",
  ];
  for (const header of headers) args.push("-H", header);
  args.push("--output", output, url);
  const res = spawnSync("curl", args, { env: environment, encoding: "utf8", timeout: 190000 });
  if (res.error || res.status !== 0) {
    throw new ActionError(`Could not download tool archive from ${new URL(url).host}.`);
  }
}

export function resolvePinDigest(toolName, pin, arch) {
  const version = pin.version;
  const expectedSha = typeof pin.sha256 === "string" ? pin.sha256 : pin.sha256?.[arch];
  if (!semverPattern.test(version ?? "") || !sha256Pattern.test(expectedSha ?? "")) {
    throw new ActionError(`Tool ${toolName} requires an exact version and ${arch} SHA-256.`);
  }
  return { version, expectedSha };
}

export function resolveHostedToolSelection({
  toolName,
  defaultRepository,
  defaultAsset,
  callerPins,
  loadFallbackPins,
  snapshot,
  arch,
}) {
  const caller = callerPins[toolName];
  if (caller) {
    const { version, expectedSha } = resolvePinDigest(toolName, caller, arch);
    if (snapshot) resolveTool(snapshot, toolName, version);
    return {
      version,
      expectedSha,
      repository: caller.repository || defaultRepository,
      assetName: caller.asset || defaultAsset(version, arch),
      source: "caller-pin",
    };
  }
  if (snapshot) {
    const digest = resolveToolDigest(snapshot, toolName, { target: `linux-${arch}`, optional: true });
    if (digest) {
      return {
        version: digest.version,
        expectedSha: digest.sha256,
        repository: digest.repository || defaultRepository,
        assetName: digest.asset,
        source: "registry-digest",
      };
    }
  }
  const fallback = loadFallbackPins()[toolName];
  if (!fallback) {
    throw new ActionError(`No hosted pin or registry digest configured for tool ${toolName}.`);
  }
  const { version, expectedSha } = resolvePinDigest(toolName, fallback, arch);
  if (snapshot) resolveTool(snapshot, toolName, version);
  return {
    version,
    expectedSha,
    repository: defaultRepository,
    assetName: defaultAsset(version, arch),
    source: "hosted-compat",
  };
}

export function downloadGitHubReleaseAsset({
  toolName,
  repository,
  tag,
  assetName,
  expectedSha,
  archivePath,
  environment,
}) {
  const registry = (environment.NDDEV_CI_ARTIFACT_REGISTRY ?? "").replace(/\/+$/, "");
  console.log(`Fetching check tool ${repository}@${tag}: ${assetName}`);
  if (registry) {
    console.log("Using the configured artifact registry.");
    curlToFile(
      `${registry}/github-releases/sha256/${expectedSha}/${repository}/releases/download/${tag}/${assetName}`,
      archivePath,
      [],
      environment,
    );
  } else {
    curlToFile(
      `https://github.com/${repository}/releases/download/${tag}/${assetName}`,
      archivePath,
      [],
      environment,
    );
  }
  if (sha256File(archivePath) !== expectedSha) {
    throw new ActionError(`Downloaded ${toolName} archive differs from its SHA-256.`);
  }
}

export function installTarOrBinary({ toolName, archivePath, tarMember, stagingDir, targetPath, environment }) {
  if (!tarMember) {
    copyFileSync(archivePath, targetPath);
    chmodSync(targetPath, 0o755);
    return;
  }
  const dest = path.join(stagingDir, toolName);
  mkdirSync(dest, { recursive: true });
  const untar = spawnSync("tar", ["-xzf", archivePath, "-C", dest, tarMember], {
    env: environment,
    encoding: "utf8",
    timeout: 60000,
  });
  if (untar.error || untar.status !== 0) {
    throw new ActionError(`Could not extract ${toolName} from its archive.`);
  }
  copyFileSync(path.join(dest, tarMember), targetPath);
  chmodSync(targetPath, 0o755);
}

export function installHostedTool({
  toolName,
  defaultRepository,
  defaultAsset,
  tarMember,
  callerPins,
  loadFallbackPins,
  snapshot,
  arch,
  binDir,
  stagingDir,
  environment,
}) {
  const chosen = resolveHostedToolSelection({
    toolName,
    defaultRepository,
    defaultAsset,
    callerPins,
    loadFallbackPins,
    snapshot,
    arch,
  });
  const targetPath = path.join(binDir, toolName);
  if (existsSync(targetPath)) rmSync(targetPath, { force: true });
  const archivePath = path.join(stagingDir, `${toolName}.archive`);
  downloadGitHubReleaseAsset({
    toolName,
    repository: chosen.repository,
    tag: `v${chosen.version}`,
    assetName: chosen.assetName,
    expectedSha: chosen.expectedSha,
    archivePath,
    environment,
  });
  installTarOrBinary({
    toolName,
    archivePath,
    tarMember: typeof tarMember === "function" ? tarMember(chosen.version) : tarMember,
    stagingDir,
    targetPath,
    environment,
  });
  return chosen;
}

export function linkManagedTool(toolName, binDir, { environment, snapshot }) {
  const found = findManagedTool(toolName, { environment, snapshot });
  const linkPath = path.join(binDir, toolName);
  rmSync(linkPath, { force: true });
  symlinkSync(found.binary, linkPath);
  console.log(`Using preinstalled ${toolName}@${found.version} from tool cache.`);
  return found;
}

export function runActionCli(metaUrl, fn, fallbackMessage = "") {
  if (!process.argv[1] || metaUrl !== pathToFileURL(path.resolve(process.argv[1])).href) return;
  try {
    fn();
  } catch (error) {
    const message = error instanceof ActionError || !fallbackMessage ? error.message : fallbackMessage;
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}
