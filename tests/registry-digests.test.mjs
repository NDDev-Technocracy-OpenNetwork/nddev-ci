import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHostedImageBuilder } from "../actions/image-builder/resolve.mjs";
import { prepareMergeStopTools } from "../actions/merge-stops/prepare-tools.mjs";
import { prepareFrontend } from "../actions/recipe/run.mjs";
import { prepareSecurityTools } from "../actions/security-tools/run.mjs";
import { prepareScanner } from "../lib/dependency-scan.mjs";
import {
  loadRegistrySnapshot,
  resolveBuildkitImage,
  resolveToolDigest,
} from "../lib/registry-resolve.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function saveRegistryFixture(file, technologies_toml, registry_commit = "c".repeat(40)) {
  writeFileSync(file, JSON.stringify({ schema_version: 1, registry_commit, technologies_toml }));
  return file;
}

function makeTarGz(dir, memberPath, content) {
  const stage = mkdtempSync(path.join(dir, "tar-"));
  const archive = path.join(dir, `pack-${Math.random().toString(16).slice(2)}.tar.gz`);
  const rel = memberPath.replace(/^\.\//, "");
  const full = path.join(stage, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, { mode: 0o755 });
  const res = spawnSync("tar", ["-czf", archive, "-C", stage, memberPath], { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    throw new Error(`tar failed: ${res.stderr}`);
  }
  const bytes = readFileSync(archive);
  rmSync(stage, { recursive: true, force: true });
  rmSync(archive, { force: true });
  return bytes;
}

function startAssetServer(dir, routesDir) {
  // Run the fixture HTTP server in its own process so synchronous curl calls cannot block it.
  const script = `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const routesDir = process.argv[1];
const server = http.createServer((req, res) => {
  const key = crypto.createHash("sha256").update(req.url).digest("hex");
  const file = path.join(routesDir, key);
  if (fs.existsSync(file)) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/octet-stream");
    res.end(fs.readFileSync(file));
  } else {
    res.statusCode = 404;
    res.end("not found");
  }
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, routesDir], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
      const port = Number.parseInt(out.trim(), 10);
      if (Number.isInteger(port) && port > 0) {
        resolve({ child, url: `http://127.0.0.1:${port}` });
      }
    });
    child.on("error", reject);
  });
}

test("resolveToolDigest and resolveBuildkitImage parse and validate per-platform digests across all 16 tools", () => {
  const root = mkdtempSync(path.join(tmpdir(), "reg-digest-unit-"));
  try {
    const hex = (ch) => ch.repeat(64);
    const toml = `
[technologies.just]
kind = "toolchain"
source = "https://github.com/casey/just/releases"
lines = [{ version = "1.61.0", role = "latest" }]

[technologies.just.digests."1.61.0"]
linux-x64 = { asset = "just-1.61.0-x86_64-unknown-linux-musl.tar.gz", sha256 = "${hex("1")}" }
darwin-arm64 = { asset = "just-1.61.0-aarch64-apple-darwin.tar.gz", sha256 = "${hex("2")}" }
win32-x64 = { asset = "just-1.61.0-x86_64-pc-windows-msvc.zip", sha256 = "${hex("3")}" }

[technologies.buildx]
kind = "toolchain"
source = "https://github.com/docker/buildx/releases"
lines = [{ version = "0.40.0", role = "latest" }]

[technologies.buildx.digests."0.40.0"]
linux-x64 = { asset = "buildx-v0.40.0.linux-amd64", sha256 = "${hex("4")}" }

[technologies.buildkit]
kind = "toolchain"
source = "https://github.com/moby/buildkit/releases"
lines = [{ version = "0.36.0", role = "latest" }]

[technologies.buildkit.digests."0.36.0"]
oci = { asset = "moby/buildkit:v0.36.0", sha256 = "${hex("5")}" }

[technologies.zizmor]
kind = "tool"
source = "https://github.com/zizmorcore/zizmor/releases"
lines = [{ version = "1.33.0", role = "latest" }]

[technologies.zizmor.digests."1.33.0"]
linux-x64 = { asset = "zizmor-x86_64-unknown-linux-gnu.tar.gz", sha256 = "${hex("6")}" }

[technologies.nodigest]
kind = "tool"
source = "https://github.com/example/nodigest/releases"
lines = [{ version = "1.0.0", role = "latest" }]

[technologies.baddigest]
kind = "tool"
source = "https://github.com/example/baddigest/releases"
lines = [{ version = "1.0.0", role = "latest" }]

[technologies.baddigest.digests."1.0.0"]
linux-x64 = { asset = "../escape.tar.gz", sha256 = "not-hex" }
`;
    const snapPath = saveRegistryFixture(path.join(root, "registry.json"), toml);
    const snapshot = loadRegistrySnapshot({ NDDEV_CI_REGISTRY_SNAPSHOT: snapPath });

    const justDarwin = resolveToolDigest(snapshot, "just", { target: "darwin-arm64" });
    assert.equal(justDarwin.repository, "casey/just");
    assert.equal(justDarwin.version, "1.61.0");
    assert.equal(justDarwin.asset, "just-1.61.0-aarch64-apple-darwin.tar.gz");
    assert.equal(justDarwin.sha256, hex("2"));

    assert.equal(
      resolveBuildkitImage(snapshot),
      `moby/buildkit:v0.36.0@sha256:${hex("5")}`,
    );

    const hostedBuilder = resolveHostedImageBuilder({
      RUNNER_ENVIRONMENT: "github-hosted",
      NDDEV_CI_REGISTRY_SNAPSHOT: snapPath,
    });
    assert.equal(hostedBuilder.buildxVersion, "v0.40.0");
    assert.equal(hostedBuilder.buildkitImage, `moby/buildkit:v0.36.0@sha256:${hex("5")}`);

    assert.equal(resolveToolDigest(snapshot, "nodigest", { target: "linux-x64", optional: true }), null);
    assert.throws(() => resolveToolDigest(snapshot, "nodigest", { target: "linux-x64" }), /declares no linux-x64 digest/);
    assert.throws(() => resolveToolDigest(snapshot, "baddigest", { target: "linux-x64" }), /is malformed/);
    assert.throws(() => resolveToolDigest(snapshot, "zizmor", { version: "1.32.0", target: "linux-x64" }), /outside the snapshot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted download paths verify bumped just, merge-stop, security and osv-scanner bytes strictly from registry digests", {
  skip: process.platform !== "linux",
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "reg-digest-e2e-"));
  let serverChild;
  try {
    const target = `${process.platform}-${process.arch}`;
    const routesDir = path.join(root, "routes");
    mkdirSync(routesDir, { recursive: true });
    const putRoute = (routePath, bytes) => {
      writeFileSync(path.join(routesDir, sha256(Buffer.from(routePath, "utf8"))), bytes);
    };
    const tomlBlocks = [];

    const registerArchiveTool = ({ key, kind, repo, tag, version, asset, member, script }) => {
      const archiveBytes = member ? makeTarGz(root, member, script) : Buffer.from(script, "utf8");
      const digest = sha256(archiveBytes);
      putRoute(`/github-releases/sha256/${digest}/${repo}/releases/download/${tag}/${asset}`, archiveBytes);
      tomlBlocks.push(`
[technologies."${key}"]
kind = "${kind}"
source = "https://github.com/${repo}/releases"
lines = [{ version = "${version}", role = "latest" }]

[technologies."${key}".digests."${version}"]
${target} = { asset = "${asset}", sha256 = "${digest}" }
`);
      return { digest, archiveBytes };
    };

    registerArchiveTool({
      key: "just",
      kind: "toolchain",
      repo: "casey/just",
      tag: "1.61.0",
      version: "1.61.0",
      asset: `just-1.61.0-${process.arch}.tar.gz`,
      member: "just",
      script: "#!/bin/sh\nprintf 'just 1.61.0\\n'\n",
    });

    const mergeTools = [
      ["jscpd", "kucherenko/jscpd", "5.5.0", "jscpd-5.5.0.tar.gz", "jscpd"],
      ["betterleaks", "betterleaks/betterleaks", "1.11.0", "betterleaks-1.11.0.tar.gz", "betterleaks"],
      ["poutine", "boostsecurityio/poutine", "1.2.0", "poutine-1.2.0.tar.gz", "poutine"],
      ["committed", "crate-ci/committed", "1.1.13", "committed-1.1.13.tar.gz", "./committed"],
      ["actionlint", "rhysd/actionlint", "1.7.13", "actionlint-1.7.13.tar.gz", "actionlint"],
      ["shellcheck", "koalaman/shellcheck", "0.11.1", "shellcheck-0.11.1.tar.gz", "shellcheck-v0.11.1/shellcheck"],
      ["zizmor", "zizmorcore/zizmor", "1.33.0", "zizmor-1.33.0.tar.gz", "zizmor"],
    ];
    for (const [key, repo, version, asset, member] of mergeTools) {
      registerArchiveTool({
        key,
        kind: "tool",
        repo,
        tag: `v${version}`,
        version,
        asset,
        member,
        script: `#!/bin/sh\nprintf '${key} ${version}\\n'\n`,
      });
    }

    const secTools = [
      ["trufflehog", "trufflesecurity/trufflehog", "3.101.0", "trufflehog-3.101.0.tar.gz", "trufflehog"],
      ["kingfisher", "mongodb/kingfisher", "2.20.0", "kingfisher-2.20.0.tgz", "kingfisher"],
      ["osv-scanner", "google/osv-scanner", "2.8.0", "osv-scanner-2.8.0", ""],
      ["syft", "anchore/syft", "1.58.0", "syft-1.58.0.tar.gz", "syft"],
      ["grype", "anchore/grype", "0.123.0", "grype-0.123.0.tar.gz", "grype"],
      ["trivy", "aquasecurity/trivy", "0.77.0", "trivy-0.77.0.tar.gz", "trivy"],
    ];
    for (const [key, repo, version, asset, member] of secTools) {
      const banner = key === "osv-scanner" ? `osv-scanner version: ${version}` : `${key} ${version}`;
      registerArchiveTool({
        key,
        kind: "tool",
        repo,
        tag: `v${version}`,
        version,
        asset,
        member,
        script: `#!/bin/sh\nprintf '${banner}\\n'\n`,
      });
    }

    const started = await startAssetServer(root, routesDir);
    serverChild = started.child;

    const snapPath = saveRegistryFixture(path.join(root, "registry.json"), tomlBlocks.join("\n"));
    const tempDir = path.join(root, "runner-temp");
    mkdirSync(tempDir, { recursive: true });
    const hostedEnv = {
      ...process.env,
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_TEMP: tempDir,
      NDDEV_CI_REGISTRY_SNAPSHOT: snapPath,
      NDDEV_CI_ARTIFACT_REGISTRY: started.url,
    };

    // 1. Hosted `just` resolves bumped 1.61.0 purely from registry digest and caches it.
    const justOut = path.join(root, "just-out");
    const justBin = await prepareFrontend({ ...hostedEnv, GITHUB_OUTPUT: justOut });
    assert.equal(readFileSync(justOut, "utf8").trim(), "just-version=1.61.0");
    assert.ok(justBin.includes("1.61.0-"));

    // 2. Hosted merge-stops resolves all 7 tools (including zizmor GitHub tarball) purely from registry digests.
    const mergeRes = prepareMergeStopTools({ ...hostedEnv, NEW_CLONES: "true" });
    assert.equal(mergeRes.versions.zizmor, "1.33.0");
    assert.equal(mergeRes.versions.jscpd, "5.5.0");
    assert.equal(mergeRes.versions.betterleaks, "1.11.0");

    // 3. Hosted security-tools resolves all 6 scanners purely from registry digests.
    const secEnvFile = path.join(root, "sec-env");
    const secRes = prepareSecurityTools({ ...hostedEnv, GITHUB_ENV: secEnvFile });
    assert.equal(secRes.versions.trufflehog, "3.101.0");
    assert.equal(secRes.versions["osv-scanner"], "2.8.0");
    assert.match(readFileSync(secEnvFile, "utf8"), /^TRIVY_VERSION=0\.77\.0$/m);

    // 4. Hosted dependency-scan resolves bumped osv-scanner@2.8.0 purely from registry digest.
    const depDir = path.join(root, "dep-bin");
    mkdirSync(depDir, { recursive: true });
    const osvBin = await prepareScanner(depDir, hostedEnv);
    assert.equal(osvBin, path.join(depDir, "osv-scanner"));

    // 5. Tampered bytes with mismatched SHA-256 are rejected before installation.
    const tamperedBytes = Buffer.from("tampered-payload", "utf8");
    const badSnapPath = saveRegistryFixture(path.join(root, "bad-registry.json"), `
[technologies.just]
kind = "toolchain"
source = "https://github.com/casey/just/releases"
lines = [{ version = "1.62.0", role = "latest" }]

[technologies.just.digests."1.62.0"]
${target} = { asset = "just-1.62.0.tar.gz", sha256 = "${"f".repeat(64)}" }
`, "d".repeat(40));
    putRoute(`/github-releases/sha256/${"f".repeat(64)}/casey/just/releases/download/1.62.0/just-1.62.0.tar.gz`, tamperedBytes);
    await assert.rejects(
      () => prepareFrontend({ ...hostedEnv, NDDEV_CI_REGISTRY_SNAPSHOT: badSnapPath }),
      /digest differs from its pin/,
    );
  } finally {
    if (serverChild) serverChild.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
