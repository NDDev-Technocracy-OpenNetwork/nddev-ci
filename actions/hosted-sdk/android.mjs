// Prepares and verifies exact Android SDK packages from Google's official Android SDK repository
// manifest (repository2-3.xml), matching the managed ANDROID_HOME package layout and package.xml
// metadata across Linux, macOS and Windows.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { archiveProgram } from "../../lib/native-member.mjs";
import { resolveToolchain } from "../../lib/registry-resolve.mjs";
import { ActionError } from "../../lib/release-asset.mjs";
import { downloadArchive } from "./archive.mjs";

const repositoryOrigin = "https://dl.google.com/android/repository";
const manifestUrl = `${repositoryOrigin}/repository2-3.xml`;

const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const twoOrThreePartPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?$/;
const platformApiPattern = /^[1-9][0-9]*(?:\.(0|[1-9][0-9]*))?$/;
const safeArchivePattern = /^[A-Za-z0-9._+-]+\.zip$/;
const safeLicenseIdPattern = /^[A-Za-z0-9._-]+$/;

// Standard Android SDK license hashes accepted for non-interactive Gradle, AGP and Flutter builds,
// plus SHA-1 of the empty license element used in local package.xml descriptors.
const standardSdkLicenseHashes = Object.freeze([
  "8933bad161af4178b1185d1a37fbf41ea5269c55",
  "d56f5187479451eabf01fb78af6dfcb131a6481e",
  "24333f8a63b6825ea9c5514f83c2829b004d1fee",
  "da39a3ee5e6b4b0d3255bfef95601890afd80709",
]);
const emptySha1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709";

export const androidDefaultComponents = Object.freeze([
  "cmdline-tools",
  "platform-tools",
  "build-tools",
  "platform",
]);

export const androidComponents = Object.freeze({
  "cmdline-tools": Object.freeze({
    registryKey: "android-cmdline-tools",
    versionPattern: twoOrThreePartPattern,
    packagePath: (version) => `cmdline-tools;${version}`,
    subdir: (version) => path.join("cmdline-tools", version),
    strip: 1,
    artifact: (platform) => path.join("bin", platform === "win32" ? "sdkmanager.bat" : "sdkmanager"),
    pathSubdir: (version) => path.join("cmdline-tools", version, "bin"),
    matchRevision: false,
  }),
  "platform-tools": Object.freeze({
    registryKey: "android-platform-tools",
    versionPattern: semverPattern,
    packagePath: () => "platform-tools",
    subdir: () => "platform-tools",
    strip: 1,
    artifact: (platform) => (platform === "win32" ? "adb.exe" : "adb"),
    pathSubdir: () => "platform-tools",
    matchRevision: true,
  }),
  "build-tools": Object.freeze({
    registryKey: "android-build-tools",
    versionPattern: semverPattern,
    packagePath: (version) => `build-tools;${version}`,
    subdir: (version) => path.join("build-tools", version),
    strip: 1,
    artifact: (platform) => (platform === "win32" ? "aapt2.exe" : "aapt2"),
    pathSubdir: () => "",
    matchRevision: false,
  }),
  platform: Object.freeze({
    registryKey: "android-platform",
    versionPattern: platformApiPattern,
    packagePath: (version) => `platforms;android-${version}`,
    subdir: (version) => path.join("platforms", `android-${version}`),
    strip: 1,
    artifact: () => "android.jar",
    pathSubdir: () => "",
    matchRevision: false,
  }),
  ndk: Object.freeze({
    registryKey: "android-ndk",
    versionPattern: semverPattern,
    packagePath: (version) => `ndk;${version}`,
    subdir: (version) => path.join("ndk", version),
    strip: 1,
    artifact: () => "source.properties",
    pathSubdir: () => "",
    matchRevision: false,
  }),
  cmake: Object.freeze({
    registryKey: "android-cmake",
    versionPattern: semverPattern,
    packagePath: (version) => `cmake;${version}`,
    subdir: (version) => path.join("cmake", version),
    strip: 0,
    artifact: (platform) => path.join("bin", platform === "win32" ? "cmake.exe" : "cmake"),
    pathSubdir: () => "",
    matchRevision: false,
  }),
});

export function normalizeAndroidComponent(rawName) {
  const trimmed = String(rawName ?? "").trim();
  const stripped = trimmed.startsWith("android-") ? trimmed.slice("android-".length) : trimmed;
  return Object.hasOwn(androidComponents, stripped) ? stripped : "";
}

export function parseAndroidSdkSpec(raw, snapshot = null) {
  const input = String(raw ?? "").trim();
  if (input === "") return { entries: [], normalized: "", versions: {} };
  if (input.length > 1024) {
    throw new ActionError("Android SDK packages must be comma-separated name@exact-version entries, each component once.");
  }
  const seen = new Set();
  const entries = [];
  const versions = {};
  for (const rawEntry of input.split(",")) {
    if (!rawEntry) {
      throw new ActionError("Android SDK packages must be comma-separated name@exact-version entries, each component once.");
    }
    const at = rawEntry.indexOf("@");
    const rawName = at === -1 ? rawEntry : rawEntry.slice(0, at);
    const component = normalizeAndroidComponent(rawName);
    if (!component || seen.has(component)) {
      throw new ActionError(`Unknown or duplicate Android SDK component: ${JSON.stringify(rawName)}.`);
    }
    seen.add(component);
    const spec = androidComponents[component];
    let version;
    if (at === -1) {
      if (!snapshot) {
        throw new ActionError("Bare Android SDK component names require NDDEV_CI_REGISTRY_SNAPSHOT.");
      }
      version = resolveToolchain(snapshot, spec.registryKey).version;
    } else {
      version = rawEntry.slice(at + 1);
      if (snapshot) resolveToolchain(snapshot, spec.registryKey, version);
    }
    if (!spec.versionPattern.test(version)) {
      throw new ActionError(`The Android ${component} selection must be an exact stable version.`);
    }
    entries.push({ name: component, registryKey: spec.registryKey, version });
    versions[component] = version;
  }
  const normalized = entries.map((entry) => `${entry.name}@${entry.version}`).join(",");
  return { entries, normalized, versions };
}

export function androidCachePaths(cacheRoot, entries) {
  if (!entries.length) return [];
  const paths = [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => path.join(cacheRoot, "android", androidComponents[entry.name].subdir(entry.version)));
  paths.push(path.join(cacheRoot, "android", "licenses"));
  return paths;
}

export function androidHomePath(environment, isManaged) {
  const raw = isManaged
    ? (environment.ANDROID_HOME || environment.ANDROID_SDK_ROOT ||
        (environment.RUNNER_TOOL_CACHE ? path.join(environment.RUNNER_TOOL_CACHE, "android") : ""))
    : (environment.RUNNER_TOOL_CACHE ? path.join(environment.RUNNER_TOOL_CACHE, "android") : "");
  if (!raw || !path.isAbsolute(raw) || /[\r\n\0]/.test(raw)) {
    throw new ActionError(
      isManaged
        ? "A managed Android SDK requires an absolute ANDROID_HOME or RUNNER_TOOL_CACHE."
        : "Android SDK preparation requires an absolute RUNNER_TOOL_CACHE.",
    );
  }
  return raw;
}

function tagText(block, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
  return match ? match[1].trim() : "";
}

function parseRevision(block) {
  const revBlock = tagText(block, "revision");
  if (!revBlock) return "";
  const parts = [];
  for (const part of ["major", "minor", "micro"]) {
    const value = tagText(revBlock, part);
    if (!value) break;
    parts.push(value);
  }
  return parts.join(".");
}

function hostOsName(platform) {
  return { linux: "linux", darwin: "macosx", win32: "windows" }[platform] ?? "";
}

function hostArchAliases(arch) {
  if (arch === "x64") return ["x64", "x86_64"];
  if (arch === "arm64") return ["aarch64", "arm64"];
  return [arch];
}

function buildLocalPackageXml(manifestXml, remoteBlock, licenseId) {
  const repoHeader = /<sdk:sdk-repository\b([^>]*)>/.exec(manifestXml)?.[1] ?? "";
  const namespaces = repoHeader.match(/\bxmlns:[A-Za-z0-9_-]+="[^"]+"/g) ?? [];
  if (!namespaces.length) {
    throw new ActionError("The Android SDK repository manifest declares no XML namespaces.");
  }
  const withoutArchives = remoteBlock.replace(/<archives>[\s\S]*?<\/archives>/, "");
  const collapsed = withoutArchives
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("<channelRef"))
    .join("");
  if (!collapsed.startsWith("<remotePackage ") || !collapsed.endsWith("</remotePackage>")) {
    throw new ActionError("The Android SDK package descriptor is malformed.");
  }
  const localBody = collapsed
    .replace(/^<remotePackage\s+path=(["'][^"']+["'])/, "<localPackage path=$1 obsolete=\"false\"")
    .replace(/<\/remotePackage>$/, "</localPackage>");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><common:repository ${namespaces.join(" ")}><license id="${licenseId}" type="text"/>${localBody}</common:repository>`;
}

export function parseAndroidPackage(manifestXml, componentName, version, platform = process.platform, arch = process.arch) {
  const component = normalizeAndroidComponent(componentName);
  if (!component) throw new ActionError(`Unknown Android SDK component: ${componentName}.`);
  const spec = androidComponents[component];
  if (!spec.versionPattern.test(version)) {
    throw new ActionError(`The Android ${component} selection must be an exact stable version.`);
  }
  const hostOs = hostOsName(platform);
  if (!hostOs || (platform !== "darwin" && arch !== "x64") || !["x64", "arm64"].includes(arch)) {
    throw new ActionError("Android SDK publishes no host binaries for this system and architecture; select an x64 or macOS runner.");
  }
  const archAliases = hostArchAliases(arch);
  const expectedPath = spec.packagePath(version);

  const licenses = new Map();
  const licensePattern = /<license\s+id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/license>/g;
  for (const match of manifestXml.matchAll(licensePattern)) {
    licenses.set(match[1], match[2]);
  }

  const matches = [];
  const packagePattern = /<remotePackage\s+path=["']([^"']+)["'][^>]*>[\s\S]*?<\/remotePackage>/g;
  for (const match of manifestXml.matchAll(packagePattern)) {
    const pkgPath = match[1];
    const block = match[0];
    if (pkgPath !== expectedPath) continue;
    if (!/<channelRef\s+ref=["']channel-0["']\s*\/>/.test(block)) continue;
    const rev = parseRevision(block);
    if (spec.matchRevision && rev !== version) continue;

    const archivesBlock = tagText(block, "archives");
    const candidates = [];
    for (const archiveMatch of archivesBlock.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
      const archive = archiveMatch[1];
      const osTag = tagText(archive, "host-os");
      const archTag = tagText(archive, "host-arch");
      if (osTag && osTag !== hostOs) continue;
      if (archTag && !archAliases.includes(archTag)) continue;
      const complete = tagText(archive, "complete");
      const filename = tagText(complete, "url");
      const sizeText = tagText(complete, "size");
      const checksumMatch = /<checksum\s+type=["'](sha1|sha256)["']>([0-9a-fA-F]+)<\/checksum>/.exec(complete);
      if (!safeArchivePattern.test(filename) || !/^[1-9][0-9]*$/.test(sizeText) || !checksumMatch) continue;
      const algorithm = checksumMatch[1];
      const checksum = checksumMatch[2].toLowerCase();
      const expectedLength = algorithm === "sha256" ? 64 : 40;
      if (checksum.length !== expectedLength) continue;
      const size = Number.parseInt(sizeText, 10);
      if (!Number.isSafeInteger(size) || size <= 0) continue;
      candidates.push({
        specificArch: Boolean(archTag),
        filename,
        size,
        algorithm,
        checksum,
      });
    }
    if (!candidates.length) continue;
    candidates.sort((a, b) => Number(b.specificArch) - Number(a.specificArch));
    const chosen = candidates[0];
    const licenseId = /<uses-license\s+ref=["']([^"']+)["']\s*\/>/.exec(block)?.[1] ?? "";
    if (!safeLicenseIdPattern.test(licenseId)) {
      throw new ActionError(`Android SDK package ${expectedPath} declares an invalid license identifier.`);
    }
    matches.push({
      name: component,
      version,
      revision: rev,
      packagePath: expectedPath,
      subdir: spec.subdir(version),
      strip: spec.strip,
      artifact: spec.artifact(platform),
      pathSubdir: spec.pathSubdir(version),
      url: `${repositoryOrigin}/${chosen.filename}`,
      filename: chosen.filename,
      size: chosen.size,
      algorithm: chosen.algorithm,
      checksum: chosen.checksum,
      licenseId,
      licenseText: licenses.get(licenseId) ?? "",
      packageXml: buildLocalPackageXml(manifestXml, block, licenseId),
    });
  }

  if (matches.length !== 1) {
    throw new ActionError(`Android SDK repository has no single stable ${hostOs}/${arch} package for ${component}@${version}.`);
  }
  return matches[0];
}

function sha1Hex(text) {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

export function writeAndroidLicenses(androidRoot, licenseEntries) {
  const dir = path.join(androidRoot, "licenses");
  mkdirSync(dir, { recursive: true });
  const grouped = new Map();
  for (const { licenseId, licenseText } of licenseEntries) {
    if (!safeLicenseIdPattern.test(licenseId)) {
      throw new ActionError(`Invalid Android SDK license identifier: ${licenseId}.`);
    }
    const hashes = grouped.get(licenseId) ?? new Set([emptySha1]);
    if (licenseId === "android-sdk-license") {
      for (const hash of standardSdkLicenseHashes) hashes.add(hash);
    }
    if (licenseText) {
      const normalized = licenseText.replace(/\r\n/g, "\n");
      hashes.add(sha1Hex(normalized));
      hashes.add(sha1Hex(normalized.trim()));
    }
    grouped.set(licenseId, hashes);
  }
  for (const [licenseId, hashes] of grouped) {
    const file = path.join(dir, licenseId);
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (/^[0-9a-f]{40}$/.test(trimmed)) hashes.add(trimmed);
      }
    }
    writeFileSync(file, "\n" + [...hashes].join("\n") + "\n");
  }
}

function revisionMatches(measured, expected) {
  if (!measured) return false;
  if (measured === expected) return true;
  if (expected.split(".").length === 2 && measured === `${expected}.0`) return true;
  return false;
}

function verifyPackageMetadata(pkgDir, spec, expectedVersion, component) {
  const expectedPath = spec.packagePath(expectedVersion);
  const packageXmlPath = path.join(pkgDir, "package.xml");
  if (existsSync(packageXmlPath)) {
    const xml = readFileSync(packageXmlPath, "utf8");
    const installedPath = /<localPackage\b[^>]*\bpath=["']([^"']+)["']/.exec(xml)?.[1] ?? "";
    if (installedPath !== expectedPath) {
      throw new ActionError(`The Android ${component} package at ${pkgDir} declares path ${installedPath || "(missing)"}, expected ${expectedPath}.`);
    }
    if (component !== "platform") {
      const rev = parseRevision(xml);
      if (!revisionMatches(rev, expectedVersion)) {
        throw new ActionError(`The Android ${component} package reports revision ${rev || "(missing)"}, expected ${expectedVersion}.`);
      }
    }
    return;
  }
  const propsPath = path.join(pkgDir, "source.properties");
  if (!existsSync(propsPath)) {
    throw new ActionError(`The Android ${component} package at ${pkgDir} lacks package.xml and source.properties.`);
  }
  const props = readFileSync(propsPath, "utf8");
  if (component === "platform") {
    const api = /^AndroidVersion\.ApiLevel\s*=\s*(.+)$/m.exec(props)?.[1]?.trim() ?? "";
    const majorExpected = expectedVersion.endsWith(".0") ? expectedVersion.slice(0, -2) : expectedVersion;
    if (api && api !== expectedVersion && api !== majorExpected) {
      throw new ActionError(`The Android platform package reports API level ${api}, expected ${expectedVersion}.`);
    }
    return;
  }
  const rev = /^Pkg\.Revision\s*=\s*(.+)$/m.exec(props)?.[1]?.trim() ?? "";
  if (!revisionMatches(rev, expectedVersion)) {
    throw new ActionError(`The Android ${component} package reports Pkg.Revision=${rev || "(missing)"}, expected ${expectedVersion}.`);
  }
}

export function verifyAndroidSdk(environment, entries, isManaged, platform = process.platform) {
  if (!entries.length) return { androidHome: "", bins: [], versions: {} };
  const androidHome = androidHomePath(environment, isManaged);
  const bins = [];
  const versions = {};
  for (const entry of entries) {
    const spec = androidComponents[entry.name];
    const pkgDir = path.join(androidHome, spec.subdir(entry.version));
    const artifact = path.join(pkgDir, spec.artifact(platform));
    if (!existsSync(pkgDir) || !existsSync(artifact)) {
      throw new ActionError(`The Android SDK at ${androidHome} does not provide ${entry.name}@${entry.version}.`);
    }
    verifyPackageMetadata(pkgDir, spec, entry.version, entry.name);
    const pathSubdir = spec.pathSubdir(entry.version);
    if (pathSubdir) bins.push(path.join(androidHome, pathSubdir));
    versions[entry.name] = entry.version;
  }
  return { androidHome, bins, versions };
}

export async function install(environment = process.env) {
  const { entries } = parseAndroidSdkSpec(environment.SDK_ANDROID_SDK ?? "");
  if (!entries.length) return;
  const androidRoot = androidHomePath(environment, false);
  const response = await fetch(manifestUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    throw new ActionError(`The Android SDK repository manifest failed: HTTP ${response.status}.`);
  }
  const manifestXml = await response.text();
  mkdirSync(androidRoot, { recursive: true });

  const packages = entries.map((entry) =>
    parseAndroidPackage(manifestXml, entry.name, entry.version, process.platform, process.arch),
  );
  const bins = [];
  const licenseEntries = [];

  for (const pkg of packages) {
    licenseEntries.push({ licenseId: pkg.licenseId, licenseText: pkg.licenseText });
    const targetDir = path.join(androidRoot, pkg.subdir);
    const markerPath = path.join(targetDir, ".nddev-android-digest");
    const expectedMarker = `${pkg.algorithm}:${pkg.checksum}:${pkg.size}`;
    const artifactPath = path.join(targetDir, pkg.artifact);
    const packageXmlPath = path.join(targetDir, "package.xml");

    if (
      !existsSync(artifactPath) ||
      !existsSync(packageXmlPath) ||
      !existsSync(markerPath) ||
      readFileSync(markerPath, "utf8").trim() !== expectedMarker
    ) {
      const staging = mkdtempSync(path.join(androidRoot, ".android-"));
      try {
        const archivePath = path.join(staging, pkg.filename);
        await downloadArchive(pkg.url, archivePath, pkg.checksum, `Android SDK ${pkg.packagePath}`, {
          algorithm: pkg.algorithm,
          size: pkg.size,
        });
        const extracted = path.join(staging, "extracted");
        mkdirSync(extracted, { recursive: true });
        const windows = process.platform === "win32";
        const command = windows ? archiveProgram(environment) : "unzip";
        const args = windows ? ["-xf", archivePath, "-C", extracted] : ["-q", archivePath, "-d", extracted];
        const result = spawnSync(command, args, { stdio: "inherit", timeout: 600000 });
        rmSync(archivePath, { force: true });
        if (result.error || result.status !== 0) {
          throw new ActionError(`The Android SDK archive ${pkg.filename} could not be extracted.`);
        }
        let sourceDir = extracted;
        if (pkg.strip === 1) {
          const top = readdirSync(extracted, { withFileTypes: true });
          if (top.length !== 1 || !top[0].isDirectory()) {
            throw new ActionError(`The Android SDK archive ${pkg.filename} did not hold one top-level folder.`);
          }
          sourceDir = path.join(extracted, top[0].name);
        }
        if (!existsSync(path.join(sourceDir, pkg.artifact))) {
          throw new ActionError(`The Android SDK archive ${pkg.filename} lacks ${pkg.artifact}.`);
        }
        writeFileSync(path.join(sourceDir, "package.xml"), pkg.packageXml);
        writeFileSync(path.join(sourceDir, ".nddev-android-digest"), expectedMarker);
        mkdirSync(path.dirname(targetDir), { recursive: true });
        rmSync(targetDir, { recursive: true, force: true });
        renameSync(sourceDir, targetDir);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    if (pkg.pathSubdir) bins.push(path.join(androidRoot, pkg.pathSubdir));
    console.log(`Android SDK ${pkg.name} ${pkg.version} from ${pkg.filename}, ${pkg.algorithm.toUpperCase()} ${pkg.checksum}.`);
  }

  writeAndroidLicenses(androidRoot, licenseEntries);
  if (environment.GITHUB_ENV) {
    appendFileSync(environment.GITHUB_ENV, `ANDROID_HOME=${androidRoot}\nANDROID_SDK_ROOT=${androidRoot}\n`);
  }
  if (bins.length && environment.GITHUB_PATH) {
    appendFileSync(environment.GITHUB_PATH, bins.join("\n") + "\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  install().catch((error) => {
    console.error(`::error::${error instanceof ActionError ? error.message : `Android SDK preparation failed: ${error.message}`}`);
    process.exitCode = 1;
  });
