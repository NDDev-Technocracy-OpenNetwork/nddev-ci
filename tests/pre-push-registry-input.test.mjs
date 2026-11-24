import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prePushRegistryInput } from "../lib/pre-push-registry-input.mjs";

test("a build without protected registry admission keeps its existing invocation", () => {
  assert.deepEqual(prePushRegistryInput({
    NDDEV_CI_REGISTRY_SNAPSHOT: "/work/registry.json",
  }, () => assert.fail("reads a lock without admission")), {});
});

test("pre-push binds the private snapshot to the candidate lock and the admitted digest", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "pre-push-registry-"));
  try {
    const commit = "a".repeat(40);
    const lock = "config/tools.lock.json";
    const bytes = Buffer.from(JSON.stringify({
      schema_version: 1, registry_commit: commit, technologies_toml: "",
    }));
    const file = path.join(temporary, "input.json");
    writeFileSync(file, bytes);
    const env = {
      NDDEV_CI_PRE_PUSH_REGISTRY_LOCK: lock,
      NDDEV_CI_PRE_PUSH_REGISTRY_COMMIT: commit,
      NDDEV_CI_PRE_PUSH_REGISTRY_SHA256: createHash("sha256").update(bytes).digest("hex"),
      NDDEV_CI_REGISTRY_SNAPSHOT: file,
    };
    const selection = (selected) => JSON.stringify({schema_version: 1, registry_commit: selected});
    const readLock = (name) => {
      assert.equal(name, lock);
      return selection(commit);
    };
    assert.throws(() => prePushRegistryInput({
      ...env, NDDEV_CI_REGISTRY_SNAPSHOT: undefined,
    }, readLock, temporary), /needs a job registry snapshot/);
    assert.throws(() => prePushRegistryInput(
      env, () => selection("b".repeat(40)), temporary,
    ), /candidate lock differs/);
    assert.throws(() => prePushRegistryInput({
      ...env, NDDEV_CI_PRE_PUSH_REGISTRY_SHA256: "b".repeat(64),
    }, readLock, temporary), /differs from its digest/);
    assert.throws(() => prePushRegistryInput({
      ...env, NDDEV_CI_REGISTRY_SNAPSHOT: temporary,
    }, readLock, temporary), /must be a regular file/);

    const prepared = prePushRegistryInput(env, readLock, temporary).NDDEV_CI_REGISTRY_SNAPSHOT;
    assert.equal(prepared, path.join(temporary, "registry.json"));
    assert.deepEqual(readFileSync(prepared), bytes);
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
});
