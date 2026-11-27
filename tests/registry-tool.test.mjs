import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveSelectionEnvironment } from "../actions/hosted-sdk/run.mjs";
import { prepareMergeStopTools } from "../actions/merge-stops/prepare-tools.mjs";
import { prepareSecurityTools } from "../actions/security-tools/run.mjs";
import { prepareScanner } from "../lib/dependency-scan.mjs";
import { checkTool, loadRegistrySnapshot, resolveTool } from "../lib/registry-resolve.mjs";
import { resolveBetterleaksVersion } from "../lib/secret-scan.mjs";

function writeSnapshot(dir, toml, commit = "b".repeat(40)) {
  const file = path.join(dir, "registry.json");
  writeFileSync(file, JSON.stringify({
    schema_version: 1,
    registry_commit: commit,
    technologies_toml: toml,
  }));
  return file;
}

const toolToml = `
[technologies.betterleaks]
kind = "tool"
lines = [{ version = "1.11.0", role = "latest" }]

[technologies.poutine]
kind = "tool"
lines = [{ version = "1.2.0", role = "latest" }]

[technologies.committed]
kind = "tool"
lines = [{ version = "1.1.13", role = "latest" }]

[technologies.actionlint]
kind = "tool"
lines = [{ version = "1.7.13", role = "latest" }]

[technologies.shellcheck]
kind = "tool"
lines = [{ version = "0.11.1", role = "latest" }]

[technologies.zizmor]
kind = "tool"
lines = [{ version = "1.33.0", role = "latest" }]

[technologies.jscpd]
kind = "tool"
lines = [{ version = "5.5.0", role = "latest" }]

[technologies.osv-scanner]
kind = "tool"
lines = [{ version = "2.8.0", role = "latest" }]

[technologies.trufflehog]
kind = "tool"
lines = [{ version = "3.101.0", role = "latest" }]

[technologies.kingfisher]
kind = "tool"
lines = [{ version = "2.20.0", role = "latest" }]

[technologies.syft]
kind = "tool"
lines = [{ version = "1.58.0", role = "latest" }]

[technologies.grype]
kind = "tool"
lines = [{ version = "0.123.0", role = "latest" }]

[technologies.trivy]
kind = "tool"
lines = [{ version = "0.77.0", role = "latest" }]

[technologies.cargo-nextest]
kind = "toolchain"
lines = [{ version = "0.9.155", role = "latest" }]
`;

test("tool kind resolves bare tool names and verifies versions against registry snapshot", () => {
  const root = mkdtempSync(path.join(tmpdir(), "reg-tool-"));
  try {
    const snapPath = writeSnapshot(root, toolToml);
    const snapshot = loadRegistrySnapshot({ NDDEV_CI_REGISTRY_SNAPSHOT: snapPath });

    assert.equal(resolveTool(snapshot, "betterleaks").version, "1.11.0");
    assert.equal(checkTool(snapshot, "osv-scanner", "2.8.0").version, "2.8.0");
    assert.equal(resolveTool(snapshot, "cargo-nextest").version, "0.9.155");
    assert.throws(() => checkTool(snapshot, "betterleaks", "1.10.1"), /outside the snapshot/);

    const resolved = resolveSelectionEnvironment({
      SDK_RUNNER_ENVIRONMENT: "self-hosted",
      SDK_TOOLS: "cargo-nextest,betterleaks@1.11.0",
      NDDEV_CI_REGISTRY_SNAPSHOT: snapPath,
    });
    assert.equal(resolved.tools, "cargo-nextest@0.9.155,betterleaks@1.11.0");

    assert.throws(() => resolveSelectionEnvironment({
      SDK_RUNNER_ENVIRONMENT: "self-hosted",
      SDK_TOOLS: "betterleaks@1.10.1",
      NDDEV_CI_REGISTRY_SNAPSHOT: snapPath,
    }), /outside the snapshot/);

    assert.equal(resolveBetterleaksVersion({ NDDEV_CI_REGISTRY_SNAPSHOT: snapPath }), "1.11.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed merge-stops, security-tools and dependency-scan resolve tools from RUNNER_TOOL_CACHE and snapshot", {
  skip: process.platform !== "linux",
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "reg-tool-managed-"));
  try {
    const cache = path.join(root, "cache");
    const temp = path.join(root, "temp");
    mkdirSync(temp, { recursive: true });
    const installStub = (name, version, banner) => {
      const dir = path.join(cache, name, version, process.arch);
      mkdirSync(dir, { recursive: true });
      const bin = path.join(dir, name);
      writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(banner)}\n`, { mode: 0o755 });
      return bin;
    };

    installStub("betterleaks", "1.11.0", "1.11.0");
    installStub("poutine", "1.2.0", "poutine 1.2.0");
    installStub("committed", "1.1.13", "committed 1.1.13");
    installStub("actionlint", "1.7.13", "1.7.13");
    installStub("shellcheck", "0.11.1", "ShellCheck\nversion: 0.11.1");
    installStub("zizmor", "1.33.0", "zizmor 1.33.0");
    installStub("jscpd", "5.5.0", "5.5.0");
    const osvBin = installStub("osv-scanner", "2.8.0", "osv-scanner version: 2.8.0");
    installStub("trufflehog", "3.101.0", "trufflehog 3.101.0");
    installStub("kingfisher", "2.20.0", "kingfisher 2.20.0");
    installStub("syft", "1.58.0", "syft 1.58.0");
    installStub("grype", "0.123.0", "grype 0.123.0");
    installStub("trivy", "0.77.0", "Version: 0.77.0");

    const snapPath = writeSnapshot(root, toolToml);
    const managedEnv = {
      RUNNER_ENVIRONMENT: "self-hosted",
      RUNNER_TOOL_CACHE: cache,
      RUNNER_TEMP: temp,
      NDDEV_CI_REGISTRY_SNAPSHOT: snapPath,
      PATH: path.join(root, "empty"),
    };

    const mergeResult = prepareMergeStopTools({ ...managedEnv, NEW_CLONES: "true" });
    assert.equal(mergeResult.versions.betterleaks, "1.11.0");
    assert.equal(mergeResult.versions.jscpd, "5.5.0");
    assert.equal(mergeResult.versions.zizmor, "1.33.0");

    const ghEnv = path.join(root, "sec-env");
    const ghPath = path.join(root, "sec-path");
    const secResult = prepareSecurityTools({ ...managedEnv, GITHUB_ENV: ghEnv, GITHUB_PATH: ghPath });
    assert.equal(secResult.versions.trufflehog, "3.101.0");
    assert.equal(secResult.versions.trivy, "0.77.0");
    const exported = readFileSync(ghEnv, "utf8");
    assert.match(exported, /^TRUFFLEHOG_VERSION=3\.101\.0$/m);
    assert.match(exported, /^TRIVY_VERSION=0\.77\.0$/m);

    const depBin = await prepareScanner(path.join(root, "dep-work"), managedEnv);
    assert.equal(realpathSync(depBin), realpathSync(osvBin));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
