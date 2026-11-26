// Prepares merge-stop tools for actions/merge-stops without hardcoded managed versions.
// Managed runners resolve verified binaries from NDDEV_CI_REGISTRY_SNAPSHOT and RUNNER_TOOL_CACHE.
// Hosted runners take explicit caller tool-pins or fall back to isolated hosted compatibility pins.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { hostedMergeStopPins } from "../../lib/hosted-compat-pins.mjs";
import {
  findManagedTool,
  loadRegistrySnapshot,
  resolveTool,
} from "../../lib/registry-resolve.mjs";
import { ActionError } from "../../lib/release-asset.mjs";
import { managedRunner } from "../../lib/runner-profile.mjs";

const shaPattern = /^[0-9a-f]{64}$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

const toolSpecs = Object.freeze({
  betterleaks: {
    repository: "betterleaks/betterleaks",
    asset: (v, a) => `betterleaks_${v}_linux_${a === "x64" ? "x64" : "arm64"}.tar.gz`,
    member: () => "betterleaks",
  },
  poutine: {
    repository: "boostsecurityio/poutine",
    asset: (v, a) => `poutine_Linux_${a === "x64" ? "x86_64" : "arm64"}.tar.gz`,
    member: () => "poutine",
  },
  committed: {
    repository: "crate-ci/committed",
    asset: (v, a) => `committed-v${v}-${a === "x64" ? "x86_64" : "aarch64"}-unknown-linux-musl.tar.gz`,
    member: () => "./committed",
  },
  actionlint: {
    repository: "rhysd/actionlint",
    asset: (v, a) => `actionlint_${v}_linux_${a === "x64" ? "amd64" : "arm64"}.tar.gz`,
    member: () => "actionlint",
  },
  shellcheck: {
    repository: "koalaman/shellcheck",
    asset: (v, a) => `shellcheck-v${v}.linux.${a === "x64" ? "x86_64" : "aarch64"}.tar.gz`,
    member: (v) => `shellcheck-v${v}/shellcheck`,
  },
  jscpd: {
    repository: "kucherenko/jscpd",
    asset: (v, a) => `jscpd-linux-${a === "x64" ? "x64" : "arm64"}-musl.tar.gz`,
    member: () => "jscpd",
  },
  zizmor: {
    pypi: true,
    wheel: (v, a) => `zizmor-${v}-py3-none-${a === "x64" ? "manylinux_2_28_x86_64" : "manylinux_2_24_aarch64"}.whl`,
    member: (v) => `zizmor-${v}.data/scripts/zizmor`,
  },
});

export function extractZipMember(zipBytes, memberName) {
  let eocd = -1;
  const minOffset = Math.max(0, zipBytes.length - 65557);
  for (let i = zipBytes.length - 22; i >= minOffset; i--) {
    if (zipBytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new ActionError("Wheel archive is not a valid ZIP file.");
  const entryCount = zipBytes.readUInt16LE(eocd + 10);
  let offset = zipBytes.readUInt32LE(eocd + 16);
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > zipBytes.length || zipBytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new ActionError("Wheel ZIP central directory is malformed.");
    }
    const method = zipBytes.readUInt16LE(offset + 10);
    const compressedSize = zipBytes.readUInt32LE(offset + 20);
    const uncompressedSize = zipBytes.readUInt32LE(offset + 24);
    const nameLen = zipBytes.readUInt16LE(offset + 28);
    const extraLen = zipBytes.readUInt16LE(offset + 30);
    const commentLen = zipBytes.readUInt16LE(offset + 32);
    const localHeaderOffset = zipBytes.readUInt32LE(offset + 42);
    const name = zipBytes.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;
    if (name !== memberName) continue;
    if (localHeaderOffset + 30 > zipBytes.length || zipBytes.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new ActionError("Wheel ZIP local header is malformed.");
    }
    const localNameLen = zipBytes.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBytes.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const raw = zipBytes.subarray(dataStart, dataStart + compressedSize);
    if (raw.length !== compressedSize) throw new ActionError("Wheel ZIP entry is truncated.");
    const content = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
    if (!content || content.length !== uncompressedSize) {
      throw new ActionError(`Wheel ZIP entry ${memberName} failed decompression or size check.`);
    }
    return content;
  }
  throw new ActionError(`Wheel archive does not contain ${memberName}.`);
}

function parseCallerPins(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ActionError("tool-pins must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ActionError("tool-pins must be a JSON object mapping tool names to version/sha256 pins.");
  }
  return parsed;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function curlToFile(url, output, headers, environment) {
  const args = ["--fail", "--silent", "--show-error", "--location", "--max-time", "180"];
  for (const header of headers) args.push("-H", header);
  args.push("--output", output, url);
  const res = spawnSync("curl", args, { env: environment, encoding: "utf8", timeout: 190000 });
  if (res.error || res.status !== 0) {
    throw new ActionError(`Could not download tool archive from ${new URL(url).host}.`);
  }
}

function curlJson(url, headers, environment) {
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

function downloadHostedTool(toolName, pin, arch, binDir, stagingDir, environment) {
  const spec = toolSpecs[toolName];
  const version = pin.version;
  const expectedSha = typeof pin.sha256 === "string" ? pin.sha256 : pin.sha256?.[arch];
  if (!versionPattern.test(version ?? "") || !shaPattern.test(expectedSha ?? "")) {
    throw new ActionError(`Tool ${toolName} requires an exact version and ${arch} SHA-256.`);
  }
  const registry = (environment.NDDEV_CI_ARTIFACT_REGISTRY ?? "").replace(/\/+$/, "");
  const token = (environment.GH_TOKEN ?? "").trim();
  const archive = path.join(stagingDir, `${toolName}.archive`);
  const target = path.join(binDir, toolName);

  if (spec.pypi) {
    const wheelName = spec.wheel(version, arch);
    const metadata = registry ? `${registry}/pypi/simple/zizmor/` : "https://pypi.org/simple/zizmor/";
    const origin = registry ? `${registry}/pypi-files/` : "https://files.pythonhosted.org/";
    const index = curlJson(metadata, ["Accept: application/vnd.pypi.simple.v1+json"], environment);
    const files = (index.files ?? []).filter((entry) => entry.filename === wheelName);
    if (files.length !== 1 || typeof files[0].url !== "string" || !files[0].url.startsWith(origin)) {
      throw new ActionError(`Wheel ${wheelName} is missing, ambiguous or outside its expected origin.`);
    }
    curlToFile(files[0].url, archive, [], environment);
    if (sha256File(archive) !== expectedSha) {
      throw new ActionError(`Downloaded ${toolName} archive differs from its SHA-256.`);
    }
    const binaryBytes = extractZipMember(readFileSync(archive), spec.member(version));
    writeFileSync(target, binaryBytes, { mode: 0o755 });
    chmodSync(target, 0o755);
    return;
  }

  const assetName = spec.asset(version, arch);
  const tag = `v${version}`;
  console.log(`Fetching check tool ${spec.repository}@${tag}: ${assetName}`);
  if (registry) {
    console.log("Using the configured artifact registry.");
    curlToFile(
      `${registry}/github-releases/sha256/${expectedSha}/${spec.repository}/releases/download/${tag}/${assetName}`,
      archive,
      [],
      environment,
    );
  } else {
    const headers = token ? [`Authorization: Bearer ${token}`] : [];
    const release = curlJson(
      `https://api.github.com/repos/${spec.repository}/releases/tags/${tag}`,
      [...headers, "Accept: application/vnd.github+json"],
      environment,
    );
    const matches = (release.assets ?? []).filter((entry) => entry.name === assetName);
    if (matches.length !== 1 || typeof matches[0].id !== "number") {
      throw new ActionError(`Release asset ${assetName} for ${spec.repository}@${tag} is missing or ambiguous.`);
    }
    curlToFile(
      `https://api.github.com/repos/${spec.repository}/releases/assets/${matches[0].id}`,
      archive,
      [...headers, "Accept: application/octet-stream"],
      environment,
    );
  }
  if (sha256File(archive) !== expectedSha) {
    throw new ActionError(`Downloaded ${toolName} archive differs from its SHA-256.`);
  }
  const dest = path.join(stagingDir, toolName);
  mkdirSync(dest, { recursive: true });
  const untar = spawnSync("tar", ["-xzf", archive, "-C", dest, spec.member(version)], {
    env: environment,
    encoding: "utf8",
    timeout: 60000,
  });
  if (untar.error || untar.status !== 0) {
    throw new ActionError(`Could not extract ${toolName} from its archive.`);
  }
  copyFileSync(path.join(dest, spec.member(version)), target);
  chmodSync(target, 0o755);
}

export function prepareMergeStopTools(environment = process.env) {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    throw new ActionError("The merge stops require a native Linux x64 or ARM64 runner.");
  }
  const tempRoot = (environment.RUNNER_TEMP ?? "").trim();
  if (!tempRoot || !path.isAbsolute(tempRoot)) {
    throw new ActionError("Preparing merge-stop tools requires RUNNER_TEMP.");
  }
  const newClones = environment.NEW_CLONES === "true" || environment["INPUT_NEW-CLONES"] === "true";
  const needed = [
    ...(newClones ? ["jscpd"] : []),
    "betterleaks",
    "poutine",
    "committed",
    "actionlint",
    "shellcheck",
    "zizmor",
  ];
  const binDir = path.join(tempRoot, "nddev-ci", "bin");
  mkdirSync(binDir, { recursive: true });

  const snapshot = loadRegistrySnapshot(environment);
  const isManaged = managedRunner(environment.RUNNER_ENVIRONMENT, environment.INPUT_MANAGED);
  const prepared = {};

  if (isManaged) {
    for (const toolName of needed) {
      const found = findManagedTool(toolName, { environment, snapshot });
      const linkPath = path.join(binDir, toolName);
      rmSync(linkPath, { force: true });
      symlinkSync(found.binary, linkPath);
      prepared[toolName] = found.version;
      console.log(`Using preinstalled ${toolName}@${found.version} from tool cache.`);
    }
    return { binDir, versions: prepared };
  }

  const callerPins = parseCallerPins(environment.TOOL_PINS ?? environment["INPUT_TOOL-PINS"]);
  const fallbackPins = hostedMergeStopPins(environment);
  const staging = mkdtempSync(path.join(tempRoot, "nddev-merge-tools-"));
  try {
    for (const toolName of needed) {
      const pin = callerPins[toolName] ?? fallbackPins[toolName];
      if (!pin) throw new ActionError(`No hosted pin configured for merge-stop tool ${toolName}.`);
      if (snapshot) resolveTool(snapshot, toolName, pin.version);
      const linkPath = path.join(binDir, toolName);
      if (existsSync(linkPath)) rmSync(linkPath, { force: true });
      downloadHostedTool(toolName, pin, process.arch, binDir, staging, environment);
      prepared[toolName] = pin.version;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { binDir, versions: prepared };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    prepareMergeStopTools();
  } catch (error) {
    console.error(`::error::${error instanceof ActionError ? error.message : error.message}`);
    process.exitCode = 1;
  }
}
