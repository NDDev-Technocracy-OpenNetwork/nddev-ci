// Prepares one exact stable Flutter SDK from Flutter's official release manifest and archive,
// verified by the manifest's SHA-256, in the runner's tool cache. flutter-action is not used:
// it calls actions/cache by tag, which the organizations' commit pinning refuses.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { archiveProgram } from "../../lib/native-member.mjs";
import { ActionError } from "../../lib/release-asset.mjs";

const origin = "https://storage.googleapis.com/flutter_infra_release/releases";
const systems = { linux: "linux", darwin: "macos", win32: "windows" };

export function selectRelease(document, version, platform, arch) {
  const system = systems[platform];
  if (!system) throw new ActionError("Flutter publishes no SDK for this system.");
  if (document?.base_url !== origin)
    throw new ActionError("The Flutter release manifest names another download origin.");
  const matches = (document.releases ?? []).filter(
    (release) =>
      release.channel === "stable" &&
      release.version === version &&
      (release.dart_sdk_arch ?? "x64") === arch,
  );
  if (matches.length !== 1)
    throw new ActionError(`Flutter ${version} has no single stable ${system} ${arch} SDK.`);
  const [release] = matches;
  if (
    !new RegExp(`^stable/${system}/flutter_[a-z0-9_.-]+-stable\\.(zip|tar\\.xz)$`).test(release.archive) ||
    !/^[0-9a-f]{64}$/.test(release.sha256)
  )
    throw new ActionError("The Flutter release entry has no plain archive and digest.");
  return {
    url: `${origin}/${release.archive}`,
    sha256: release.sha256,
    archive: release.archive,
    dart: release.dart_sdk_version,
  };
}

async function download(url, destination, expected) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(1800000) });
  if (!response.ok || !response.body)
    throw new ActionError(`The Flutter archive download failed: HTTP ${response.status}.`);
  const hash = createHash("sha256");
  const output = openSync(destination, "wx", 0o600);
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) written += writeSync(output, chunk, written, chunk.length - written);
    }
  } finally {
    closeSync(output);
  }
  if (hash.digest("hex") !== expected)
    throw new ActionError("The Flutter archive differs from its published digest.");
}

export async function install(environment = process.env) {
  const version = environment.SDK_FLUTTER_VERSION ?? "";
  if (!version) return;
  const cache = environment.RUNNER_TOOL_CACHE;
  const temp = environment.RUNNER_TEMP;
  if (!cache || !temp) throw new ActionError("The runner tool cache and temporary folder are required.");
  const manifest = await fetch(`${origin}/releases_${systems[process.platform]}.json`, {
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  if (!manifest.ok) throw new ActionError(`The Flutter release manifest failed: HTTP ${manifest.status}.`);
  const release = selectRelease(await manifest.json(), version, process.platform, process.arch);
  const root = path.join(cache, "flutter", `${version}-${process.arch}`);
  const marker = path.join(root, ".nddev-sha256");
  if (!existsSync(marker) || readFileSync(marker, "utf8") !== release.sha256) {
    const archive = path.join(temp, `flutter-${release.sha256}${release.archive.endsWith(".zip") ? ".zip" : ".tar.xz"}`);
    rmSync(archive, { force: true });
    await download(release.url, archive, release.sha256);
    const staging = `${root}.partial`;
    rmSync(staging, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const program = archiveProgram(environment);
    const args = release.archive.endsWith(".tar.xz") ? ["-xJf", archive, "-C", staging] : ["-xf", archive, "-C", staging];
    const result = spawnSync(program, args, { stdio: "inherit", timeout: 1800000 });
    rmSync(archive, { force: true });
    if (result.error || result.status !== 0) throw new ActionError("The Flutter archive could not be extracted.");
    if (!existsSync(path.join(staging, "flutter", "bin")))
      throw new ActionError("The Flutter archive holds no flutter/bin folder.");
    writeFileSync(path.join(staging, ".nddev-sha256"), release.sha256);
    renameSync(staging, root);
  }
  appendFileSync(environment.GITHUB_PATH, `${path.join(root, "flutter", "bin")}\n`);
  console.log(`Flutter ${version} (Dart ${release.dart}) from ${release.archive}, SHA-256 ${release.sha256}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  install().catch((error) => {
    console.error(`::error::${error instanceof ActionError ? error.message : `Flutter preparation failed: ${error.message}`}`);
    process.exitCode = 1;
  });
