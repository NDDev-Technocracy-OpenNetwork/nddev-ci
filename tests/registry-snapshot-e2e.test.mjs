import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { main as registryInputMain } from "../actions/registry-input/run.mjs";
import { resolveSelectionEnvironment } from "../actions/hosted-sdk/run.mjs";
import { prepareFrontend } from "../actions/recipe/run.mjs";
import {
  checkDockerfileImages,
  checkWorkflowActions,
  loadRegistrySnapshot,
  prepareActionFromRegistry,
} from "../lib/registry-resolve.mjs";
import { resolveBetterleaksVersion } from "../lib/secret-scan.mjs";

function deliverSnapshot(tempDir, commit, toml) {
  const bytes = Buffer.from(JSON.stringify({
    schema_version: 1,
    registry_commit: commit,
    technologies_toml: toml,
  }));
  const encoded = gzipSync(bytes).toString("base64");
  const envFile = path.join(tempDir, `env-${commit.slice(0, 8)}`);
  const stateFile = path.join(tempDir, `state-${commit.slice(0, 8)}`);
  registryInputMain({
    INPUT_COMMIT: commit,
    INPUT_SHA256: createHash("sha256").update(bytes).digest("hex"),
    INPUT_FIRST: encoded,
    RUNNER_TEMP: tempDir,
    GITHUB_ENV: envFile,
    GITHUB_STATE: stateFile,
  });
  return readFileSync(envFile, "utf8").trim().slice("NDDEV_CI_REGISTRY_SNAPSHOT=".length);
}

test("bumping all four registry kinds (toolchain, tool, image, action) in the snapshot reaches jobs with zero library changes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "reg-e2e-bump-"));
  try {
    const actionRepo = path.join(root, "action-src");
    mkdirSync(actionRepo, { recursive: true });
    const git = (...args) => execFileSync("git", [
      "-c", "user.name=Fixture",
      "-c", "user.email=fixture@example.test",
      "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=/dev/null",
      ...args,
    ], { cwd: actionRepo, encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(path.join(actionRepo, "action.yml"), "name: Checkout V1\n");
    git("add", ".");
    git("commit", "-qm", "feat: v1");
    const actionV1 = git("rev-parse", "HEAD");
    writeFileSync(path.join(actionRepo, "action.yml"), "name: Checkout V2\n");
    git("add", ".");
    git("commit", "-qm", "feat: v2");
    const actionV2 = git("rev-parse", "HEAD");

    const buildToml = (v) => `
[technologies.node]
kind = "toolchain"
lines = [{ version = "${v.node}", role = "latest" }]

[technologies.just]
kind = "toolchain"
lines = [{ version = "${v.just}", role = "latest" }]

[technologies.betterleaks]
kind = "tool"
lines = [{ version = "${v.betterleaks}", role = "latest" }]

[technologies.alpine]
kind = "image"
lines = [{ version = "${v.alpine}", role = "latest" }]

[technologies."actions/checkout"]
kind = "action"
lines = [{ version = "${v.actionVersion}", role = "latest", commit = "${v.actionCommit}" }]
`;

    const v1 = { node: "26.13.1", just: "1.59.0", betterleaks: "1.10.1", alpine: "3.24.4", actionVersion: "7.0.1", actionCommit: actionV1 };
    const v2 = { node: "26.14.0", just: "1.60.0", betterleaks: "1.11.0", alpine: "3.25.0", actionVersion: "7.1.0", actionCommit: actionV2 };

    const snap1Path = deliverSnapshot(root, "1".repeat(40), buildToml(v1));
    const snap2Path = deliverSnapshot(root, "2".repeat(40), buildToml(v2));

    for (const [snapPath, v, tag] of [[snap1Path, v1, "v1"], [snap2Path, v2, "v2"]]) {
      const snap = loadRegistrySnapshot({ NDDEV_CI_REGISTRY_SNAPSHOT: snapPath });

      // 1. toolchain
      const sdk = resolveSelectionEnvironment({
        SDK_RUNNER_ENVIRONMENT: "self-hosted",
        SDK_TOOLCHAINS: "node",
        SDK_TOOLS: "betterleaks",
        NDDEV_CI_REGISTRY_SNAPSHOT: snapPath,
      });
      assert.equal(sdk.selected.node, v.node);

      // 2. tool
      assert.equal(sdk.tools, `betterleaks@${v.betterleaks}`);
      assert.equal(resolveBetterleaksVersion({ NDDEV_CI_REGISTRY_SNAPSHOT: snapPath }), v.betterleaks);

      // 3. image
      const df = checkDockerfileImages(snap, `FROM alpine:${v.alpine}\n`);
      assert.equal(df.violations.length, 0);
      assert.equal(df.checked[0].tag, v.alpine);

      // 4. action
      const wf = checkWorkflowActions(snap, [{
        path: ".github/workflows/ci.yml",
        content: `steps:\n  - uses: actions/checkout@${v.actionCommit}\n`,
      }]);
      assert.equal(wf.violations.length, 0);
      const staged = prepareActionFromRegistry(snap, "actions/checkout", path.join(root, `staged-${tag}`), {
        sourceUrl: actionRepo,
      });
      assert.equal(staged.commit, v.actionCommit);
      assert.equal(
        readFileSync(path.join(staged.directory, "action.yml"), "utf8").replace(/\r\n/g, "\n"),
        `name: Checkout ${tag.toUpperCase()}\n`,
      );
    }

    // Also prove managed `just` switches from V1 -> V2 automatically when snapshot bumps (POSIX).
    if (process.platform !== "win32") {
      const cache = path.join(root, "cache");
      for (const ver of [v1.just, v2.just]) {
        const dir = path.join(cache, "just", ver, process.arch);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "just"), `#!/bin/sh\nprintf 'just ${ver}\\n'\n`, { mode: 0o755 });
      }
      const chosen1 = await prepareFrontend({
        RUNNER_ENVIRONMENT: "self-hosted",
        RUNNER_TOOL_CACHE: cache,
        NDDEV_CI_REGISTRY_SNAPSHOT: snap1Path,
        PATH: path.join(root, "empty"),
      });
      const chosen2 = await prepareFrontend({
        RUNNER_ENVIRONMENT: "self-hosted",
        RUNNER_TOOL_CACHE: cache,
        NDDEV_CI_REGISTRY_SNAPSHOT: snap2Path,
        PATH: path.join(root, "empty"),
      });
      assert.ok(chosen1.includes(path.join("just", v1.just)));
      assert.ok(chosen2.includes(path.join("just", v2.just)));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
