// Shared Linux tool preparation and CLI helpers for merge-stops, security-tools and image-builder.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findManagedTool } from "./registry-resolve.mjs";
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
  const args = ["--fail", "--silent", "--show-error", "--location", "--max-time", "180"];
  for (const header of headers) args.push("-H", header);
  args.push("--output", output, url);
  const res = spawnSync("curl", args, { env: environment, encoding: "utf8", timeout: 190000 });
  if (res.error || res.status !== 0) {
    throw new ActionError(`Could not download tool archive from ${new URL(url).host}.`);
  }
}

export function curlJson(url, headers, environment) {
  const args = ["--fail", "--silent", "--show-error", "--location", "--max-time", "60"];
  for (const header of headers) args.push("-H", header);
  args.push(url);
  const res = spawnSync("curl", args, {
    env: environment,
    encoding: "utf8",
    timeout: 70000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    throw new ActionError(`Could not fetch release metadata from ${new URL(url).host}.`);
  }
  return JSON.parse(res.stdout);
}

export function resolvePinDigest(toolName, pin, arch) {
  const version = pin.version;
  const expectedSha = typeof pin.sha256 === "string" ? pin.sha256 : pin.sha256?.[arch];
  if (!semverPattern.test(version ?? "") || !sha256Pattern.test(expectedSha ?? "")) {
    throw new ActionError(`Tool ${toolName} requires an exact version and ${arch} SHA-256.`);
  }
  return { version, expectedSha };
}

export function downloadGitHubReleaseAsset({
  toolName,
  repository,
  tag,
  assetName,
  expectedSha,
  archivePath,
  token,
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
    const headers = token ? [`Authorization: Bearer ${token}`] : [];
    const release = curlJson(
      `https://api.github.com/repos/${repository}/releases/tags/${tag}`,
      [...headers, "Accept: application/vnd.github+json"],
      environment,
    );
    const matches = (release.assets ?? []).filter((entry) => entry.name === assetName);
    if (matches.length !== 1 || typeof matches[0].id !== "number") {
      throw new ActionError(`Release asset ${assetName} for ${repository}@${tag} is missing or ambiguous.`);
    }
    curlToFile(
      `https://api.github.com/repos/${repository}/releases/assets/${matches[0].id}`,
      archivePath,
      [...headers, "Accept: application/octet-stream"],
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
