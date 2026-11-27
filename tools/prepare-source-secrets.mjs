import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const detectorVersion = "1.10.1";
const detectorDigests = new Map([
  ["linux_x64", "c174b42d7aa60caf58c0c3e555c0e4bed01fe6b0d99a412bce777b5af4ce913e"],
  ["linux_arm64", "62a63199f9f61a6b5e5a6f58f048493db20fbc8c770014f4d903a4d97886e1bf"],
  ["darwin_x64", "1ae2e3885d161918d8ad2e911e205e73f0d9ffba52c85b38126586c52d355ef4"],
  ["darwin_arm64", "ca91eb3b006f15478411f235b5e2712fb15cea74f6701ebadc2364efe0af1403"],
]);

function run(program, arguments_) {
  const result = spawnSync(program, arguments_, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(program + " could not prepare the source scanner.");
}

function download({ release, digest }, output) {
  const registry = (process.env.NDDEV_CI_ARTIFACT_REGISTRY ?? "").replace(/\/+$/, "");
  const url = registry
    ? registry + "/github-releases/sha256/" + digest + "/" + release
    : "https://github.com/" + release;
  run("curl", ["--fail", "--silent", "--show-error", "--location", url, "--output", output]);
  if (createHash("sha256").update(readFileSync(output)).digest("hex") !== digest) {
    throw new Error("The source check download differs from its declared SHA-256.");
  }
}

function complete(directory) {
  return (
    existsSync(path.join(directory, "bin/betterleaks")) &&
    existsSync(path.join(directory, "tools/scan-source-secrets.mjs"))
  );
}

function ready(directory, identity) {
  const marker = path.join(directory, ".source-secrets");
  return complete(directory) && existsSync(marker) && readFileSync(marker, "utf8") === identity;
}

function fallbackDetector() {
  const platform = process.platform + "_" + process.arch;
  const digest = detectorDigests.get(platform);
  if (!digest) throw new Error("The source scanner has no Betterleaks asset for " + platform + ".");
  return {
    release:
      "betterleaks/betterleaks/releases/download/v" +
      detectorVersion +
      "/betterleaks_" +
      detectorVersion +
      "_" +
      platform +
      ".tar.gz",
    digest,
  };
}

async function resolveDetectorFromSnapshot(sourceRoot) {
  if (!(process.env.NDDEV_CI_REGISTRY_SNAPSHOT ?? "").trim()) return null;
  const resolverPath = path.join(sourceRoot, "lib", "registry-resolve.mjs");
  if (!existsSync(resolverPath)) return null;
  const { loadRegistrySnapshot, resolveToolDigest } = await import(pathToFileURL(resolverPath).href);
  const snapshot = loadRegistrySnapshot(process.env);
  if (!snapshot) return null;
  const digest = resolveToolDigest(snapshot, "betterleaks", {
    target: `${process.platform}-${process.arch}`,
    optional: true,
  });
  if (!digest) return null;
  const repo = digest.repository || "betterleaks/betterleaks";
  return {
    release: `${repo}/releases/download/v${digest.version}/${digest.asset}`,
    digest: digest.sha256,
  };
}

async function install(destination, scanner) {
  const hasSnapshot = Boolean((process.env.NDDEV_CI_REGISTRY_SNAPSHOT ?? "").trim());
  const defaultDetector = hasSnapshot ? null : fallbackDetector();
  if (defaultDetector) {
    const identity = scanner.digest + " " + defaultDetector.digest + "\n";
    if (ready(destination, identity)) return;
    if (existsSync(destination)) throw new Error("The destination contains a different source checker.");
  }

  const parent = path.dirname(destination);
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(path.join(parent, ".prepare-"));
  try {
    const archive = path.join(stage, "scanner.zip");
    download(scanner, archive);
    run("unzip", ["-q", archive, "-d", stage]);
    const source = path.join(stage, "nddev-ci");
    const detector = (await resolveDetectorFromSnapshot(source)) ?? fallbackDetector();
    const identity = scanner.digest + " " + detector.digest + "\n";
    if (ready(destination, identity)) return;
    if (existsSync(destination)) throw new Error("The destination contains a different source checker.");

    const bin = path.join(source, "bin");
    mkdirSync(bin);
    const tar = path.join(stage, "betterleaks.tar.gz");
    download(detector, tar);
    run("tar", ["-xzf", tar, "-C", bin, "betterleaks"]);
    if (!complete(source)) throw new Error("The released source checker is incomplete.");
    writeFileSync(path.join(source, ".source-secrets"), identity, { flag: "wx" });
    try {
      renameSync(source, destination);
    } catch (error) {
      if (!ready(destination, identity)) throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

try {
  const [destination, tag, digest] = process.argv.slice(2);
  if (
    process.argv.length !== 5 || !destination ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag) || !/^[a-f0-9]{64}$/.test(digest)
  ) {
    throw new Error("Usage: prepare-source-secrets.mjs <destination> <release-tag> <archive-sha256>");
  }
  await install(path.resolve(destination), {
    release: "NDDev-Technocracy-OpenNetwork/nddev-ci/releases/download/" + tag + "/scan-before-push.zip",
    digest,
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
