import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runNextestStep } from "../actions/nextest-shards/run.mjs";
import { buildArchiveArgs, buildRunArgs, parseStringArrayInput, validateShardConfig } from "../lib/nextest-shards.mjs";

test("validateShardConfig builds deterministic slice and hash matrices and rejects deprecated count", () => {
  const sliced = validateShardConfig({ shards: 3, strategy: "slice", profile: "ci" });
  assert.equal(sliced.shards, 3);
  assert.equal(sliced.strategy, "slice");
  assert.deepEqual(sliced.matrix, [
    { shard: 1, total: 3, partition: "slice:1/3" },
    { shard: 2, total: 3, partition: "slice:2/3" },
    { shard: 3, total: 3, partition: "slice:3/3" },
  ]);

  const hashed = validateShardConfig({ shards: 2, strategy: "hash" });
  assert.deepEqual(hashed.matrix, [
    { shard: 1, total: 2, partition: "hash:1/2" },
    { shard: 2, total: 2, partition: "hash:2/2" },
  ]);

  assert.throws(() => validateShardConfig({ shards: 2, strategy: "count" }), /deprecated/);
  assert.throws(() => validateShardConfig({ shards: 1, strategy: "slice" }), /between 2 and 16/);
  assert.throws(() => validateShardConfig({ shards: 17, strategy: "slice" }), /between 2 and 16/);
  assert.throws(() => validateShardConfig({ shards: 2, strategy: "unknown" }), /slice.*hash/);
  assert.throws(() => validateShardConfig({ shards: 2, strategy: "slice", profile: "bad;cmd" }), /safe characters/);
});

test("buildArchiveArgs and buildRunArgs construct locked nextest invocations safely", () => {
  assert.deepEqual(
    buildArchiveArgs({ archiveFile: "/tmp/a.tar.zst", extraArgs: ["--workspace", "--all-targets"] }),
    ["nextest", "archive", "--locked", "--archive-file", "/tmp/a.tar.zst", "--workspace", "--all-targets"],
  );
  assert.deepEqual(
    buildRunArgs({ archiveFile: "/tmp/a.tar.zst", extractTo: "/tmp/ex", partition: "slice:2/4", profile: "ci", extraArgs: ["--no-fail-fast"] }),
    ["nextest", "run", "--archive-file", "/tmp/a.tar.zst", "--partition", "slice:2/4", "--extract-to", "/tmp/ex", "--profile", "ci", "--no-fail-fast"],
  );
  assert.throws(() => buildRunArgs({ archiveFile: "/tmp/a.tar.zst", partition: "count:1/2" }), /slice:m\/n or hash:m\/n/);
  assert.deepEqual(parseStringArrayInput('["--workspace"]', "args"), ["--workspace"]);
  assert.throws(() => parseStringArrayInput('["--bad\\narg"]', "args"), /single-line/);
});

test("nextest-shards workflow uses GHCR OCI artifacts for private repos and plan mode writes matrix", async () => {
  const workflow = readFileSync(new URL("../.github/workflows/nextest-shards.yml", import.meta.url), "utf8");
  assert.match(workflow, /uses: \$\/actions\/oci-artifact/);
  assert.match(workflow, /!github\.event\.repository\.private[\s\S]*actions\/upload-artifact@/);
  assert.match(workflow, /!github\.event\.repository\.private[\s\S]*actions\/download-artifact@/);

  const root = mkdtempSync(path.join(tmpdir(), "nextest-plan-"));
  try {
    const out = path.join(root, "out");
    writeFileSync(out, "");
    const code = await runNextestStep({
      GITHUB_WORKSPACE: root,
      GITHUB_OUTPUT: out,
      INPUT_MODE: "plan",
      INPUT_SHARDS: "4",
      "INPUT_PARTITION-STRATEGY": "slice",
      "INPUT_NEXTEST-PROFILE": "ci",
      INPUT_ARGUMENTS: '["--no-fail-fast"]',
      "INPUT_WORKING-DIRECTORY": ".",
    });
    assert.equal(code, 0);
    const written = readFileSync(out, "utf8");
    assert.match(written, /"partition":"slice:4\/4"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
