import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main as hostedSdkMain, resolveSelectionEnvironment } from "../actions/hosted-sdk/run.mjs";
import { prepareFrontend } from "../actions/recipe/run.mjs";
import {
  checkToolchain,
  loadRegistrySnapshot,
  resolveToolchain,
} from "../lib/registry-resolve.mjs";

function writeSnapshot(dir, toml, commit = "a".repeat(40)) {
  const file = path.join(dir, "registry.json");
  writeFileSync(file, JSON.stringify({
    schema_version: 1,
    registry_commit: commit,
    technologies_toml: toml,
  }));
  return file;
}

const sampleToml = `
[technologies.node]
kind = "toolchain"
lines = [{ version = "26.13.1", role = "latest" }]

[technologies.rust]
kind = "toolchain"
lines = [{ version = "1.100.0", role = "latest" }]

[technologies.jdk]
kind = "toolchain"
lines = [
  { version = "27.0.1.1", role = "latest" },
  { version = "25.0.5.1", role = "compat" },
]

[technologies."flutter+dart"]
kind = "toolchain"
lines = [{ version = "3.50.1", role = "latest" }]

[technologies.dotnet]
kind = "toolchain"
lines = [{ version = "11.0.100", role = "latest" }]

[technologies.ruby]
kind = "toolchain"
lines = [{ version = "4.0.10", role = "latest" }]

[technologies.just]
kind = "toolchain"
lines = [
  { version = "1.60.0", role = "latest" },
  { version = "1.59.0", role = "compat" },
]
`;

test("toolchain kind resolves latest and validates explicit versions against registry snapshot", () => {
  const root = mkdtempSync(path.join(tmpdir(), "reg-toolchain-"));
  try {
    const snapshotPath = writeSnapshot(root, sampleToml);
    const snapshot = loadRegistrySnapshot({ NDDEV_CI_REGISTRY_SNAPSHOT: snapshotPath });

    assert.equal(resolveToolchain(snapshot, "node").version, "26.13.1");
    assert.equal(resolveToolchain(snapshot, "rust").version, "1.100.0");
    assert.equal(resolveToolchain(snapshot, "java").version, "27.0.1.1");
    assert.equal(resolveToolchain(snapshot, "java", "25.0.5.1+2").version, "25.0.5.1+2");
    assert.equal(resolveToolchain(snapshot, "flutter").version, "3.50.1");
    assert.equal(resolveToolchain(snapshot, "dotnet").version, "11.0.100");
    assert.equal(resolveToolchain(snapshot, "ruby").version, "4.0.10");
    assert.equal(checkToolchain(snapshot, "just", "1.59.0").version, "1.59.0");
    assert.equal(resolveToolchain(snapshot, "just").version, "1.60.0");

    assert.throws(() => resolveToolchain(snapshot, "node", "24.0.0"), /outside the snapshot/);
    assert.throws(() => resolveToolchain(snapshot, "java", "21.0.1"), /outside the snapshot/);
    assert.throws(() => resolveToolchain(snapshot, "dotnet", "9.0.100"), /outside the snapshot/);
    assert.throws(() => resolveToolchain(snapshot, "ruby", "3.4.1"), /outside the snapshot/);
    assert.throws(() => resolveToolchain(snapshot, "missing"), /does not declare toolchain/);

    // actions/hosted-sdk resolves SDK_TOOLCHAINS from snapshot and validates explicit selections.
    const resolved = resolveSelectionEnvironment({
      SDK_RUNNER_ENVIRONMENT: "self-hosted",
      SDK_TOOLCHAINS: "node,rust,dotnet,ruby",
      NDDEV_CI_REGISTRY_SNAPSHOT: snapshotPath,
    });
    assert.deepEqual(resolved.selected, { node: "26.13.1", rust: "1.100.0", dotnet: "11.0.100", ruby: "4.0.10" });

    assert.throws(() => resolveSelectionEnvironment({
      SDK_RUNNER_ENVIRONMENT: "self-hosted",
      SDK_TOOLCHAINS: "node",
    }), /requires NDDEV_CI_REGISTRY_SNAPSHOT/);

    assert.throws(() => resolveSelectionEnvironment({
      SDK_RUNNER_ENVIRONMENT: "self-hosted",
      SDK_NODE_VERSION: "24.0.0",
      NDDEV_CI_REGISTRY_SNAPSHOT: snapshotPath,
    }), /outside the snapshot/);

    const out = path.join(root, "validate.out");
    hostedSdkMain("validate", {
      SDK_RUNNER_ENVIRONMENT: "self-hosted",
      SDK_TOOLCHAINS: "node,rust,dotnet,ruby",
      NDDEV_CI_REGISTRY_SNAPSHOT: snapshotPath,
      GITHUB_OUTPUT: out,
    });
    const outText = readFileSync(out, "utf8");
    assert.match(outText, /^node-version=26\.13\.1$/m);
    assert.match(outText, /^rust-version=1\.100\.0$/m);
    assert.match(outText, /^dotnet-version=11\.0\.100$/m);
    assert.match(outText, /^ruby-version=4\.0\.10$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed just frontend selects the snapshot version from RUNNER_TOOL_CACHE without hardcoded pins", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "reg-just-"));
  try {
    const cache = path.join(root, "tool-cache");
    const installJust = (version) => {
      const dir = path.join(cache, "just", version, process.arch);
      mkdirSync(dir, { recursive: true });
      const bin = path.join(dir, "just");
      writeFileSync(bin, `#!/bin/sh\nprintf 'just ${version}\\n'\n`, { mode: 0o755 });
      return bin;
    };
    const v59 = installJust("1.59.0");
    const v60 = installJust("1.60.0");

    const snap = writeSnapshot(root, sampleToml);
    const out = path.join(root, "out");
    const ghPath = path.join(root, "gh-path");
    const chosen = await prepareFrontend({
      RUNNER_ENVIRONMENT: "self-hosted",
      RUNNER_TOOL_CACHE: cache,
      NDDEV_CI_REGISTRY_SNAPSHOT: snap,
      PATH: path.join(root, "empty"),
      GITHUB_OUTPUT: out,
      GITHUB_PATH: ghPath,
    });
    const v60Real = realpathSync(v60);
    assert.equal(chosen, v60Real);
    assert.equal(readFileSync(out, "utf8").trim(), "just-version=1.60.0");
    assert.equal(readFileSync(ghPath, "utf8").trim(), path.dirname(v60Real));

    // Without a snapshot, a managed runner still works with its highest verified tool-cache just.
    const outNoSnap = path.join(root, "out-nosnap");
    const chosenNoSnap = await prepareFrontend({
      RUNNER_ENVIRONMENT: "self-hosted",
      RUNNER_TOOL_CACHE: cache,
      PATH: path.join(root, "empty"),
      GITHUB_OUTPUT: outNoSnap,
    });
    assert.equal(chosenNoSnap, v60Real);
    assert.equal(readFileSync(outNoSnap, "utf8").trim(), "just-version=1.60.0");

    // Requesting a version outside the snapshot fails cleanly.
    await assert.rejects(() => prepareFrontend({
      RUNNER_ENVIRONMENT: "self-hosted",
      RUNNER_TOOL_CACHE: cache,
      NDDEV_CI_REGISTRY_SNAPSHOT: snap,
      "INPUT_JUST-VERSION": "1.50.0",
      PATH: path.dirname(v59),
    }), /outside the snapshot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
