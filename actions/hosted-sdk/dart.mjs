import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { archiveProgram } from "../../lib/native-member.mjs";
import { ActionError } from "../../lib/release-asset.mjs";
import { downloadArchive } from "./archive.mjs";

const origin = "https://storage.googleapis.com/dart-archive/channels/stable/release";
const systems = { linux: "linux", darwin: "macos", win32: "windows" };

export function dartArchive(version, platform, arch) {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version))
    throw new ActionError("The Dart selection must be an exact stable version.");
  const system = systems[platform];
  if (!Object.hasOwn(systems, platform) || !["x64", "arm64"].includes(arch))
    throw new ActionError("The standalone Dart SDK needs a supported x64 or ARM64 system.");
  const filename = `dartsdk-${system}-${arch}-release.zip`;
  return { filename, url: `${origin}/${version}/sdk/${filename}` };
}

export function dartDigest(text, filename) {
  const lines = text.trim().split(/\r?\n/);
  const match = /^([0-9a-f]{64})[ \t]+\*?([a-z0-9._-]+)$/.exec(lines[0]);
  if (lines.length !== 1 || !match || match[2] !== filename)
    throw new ActionError("The Dart checksum does not name exactly the selected archive.");
  return match[1];
}

export async function install(environment = process.env) {
  const version = environment.SDK_DART_VERSION;
  const cache = environment.RUNNER_TOOL_CACHE;
  if (!path.isAbsolute(cache ?? ""))
    throw new ActionError("Dart preparation requires an absolute tool cache.");

  const release = dartArchive(version, process.platform, process.arch);
  const response = await fetch(`${release.url}.sha256sum`, {
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new ActionError(`The Dart release checksum failed: HTTP ${response.status}.`);
  const sha256 = dartDigest(await response.text(), release.filename);
  const parent = path.join(cache, "dart");
  const root = path.join(parent, `${version}-${process.arch}`);
  const marker = path.join(root, ".nddev-sha256");
  const executable = process.platform === "win32" ? "dart.exe" : "dart";
  const bin = path.join(root, "dart-sdk", "bin");
  if (!existsSync(path.join(bin, executable)) || !existsSync(marker) || readFileSync(marker, "utf8") !== sha256) {
    mkdirSync(parent, { recursive: true });
    const staging = mkdtempSync(path.join(parent, ".dart-"));
    try {
      const archive = path.join(staging, release.filename);
      await downloadArchive(release.url, archive, sha256, "Dart");
      const windows = process.platform === "win32";
      const command = windows ? archiveProgram(environment) : "unzip";
      const args = windows ? ["-xf", archive, "-C", staging] : ["-q", archive, "-d", staging];
      const result = spawnSync(command, args, { stdio: "inherit", timeout: 300000 });
      if (result.error || result.status !== 0 || !existsSync(path.join(staging, "dart-sdk", "bin", executable)))
        throw new ActionError("The Dart archive did not provide the selected SDK.");
      rmSync(archive);
      writeFileSync(path.join(staging, ".nddev-sha256"), sha256);
      rmSync(root, { recursive: true, force: true });
      renameSync(staging, root);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  appendFileSync(environment.GITHUB_PATH, `${bin}\n`);
  console.log(`Dart ${version} from ${release.filename}, SHA-256 ${sha256}.`);
}
