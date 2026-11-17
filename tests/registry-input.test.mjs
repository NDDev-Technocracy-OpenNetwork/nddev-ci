import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main, snapshot } from "../actions/registry-input/run.mjs";

const commit = "a".repeat(40);
const body = Buffer.from(JSON.stringify({
  schema_version: 1,
  registry_commit: commit,
  technologies_toml: "[tool]\nversion = '1.0.0'\n",
}));
const parts = gzipSync(body).toString("base64");
const input = {
  INPUT_COMMIT: commit,
  INPUT_SHA256: createHash("sha256").update(body).digest("hex"),
  INPUT_FIRST: parts.slice(0, 36),
  INPUT_SECOND: parts.slice(36),
};

test("a prepared input retains its bytes and stays in the job's directory", () => {
  const temp = mkdtempSync(join(tmpdir(), "registry-input-test-"));
  try {
    const env = join(temp, "env");
    const state = join(temp, "state");
    main({ ...input, RUNNER_TEMP: temp, GITHUB_ENV: env, GITHUB_STATE: state });
    const directory = readFileSync(state, "utf8").trim().split("=")[1];
    const path = join(directory, "registry.json");
    assert.equal(readFileSync(env, "utf8"), "NDDEV_CI_REGISTRY_SNAPSHOT=" + path + "\n");
    assert.deepEqual(readFileSync(path), body);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o400);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("a missing or substituted input fails before publication", () => {
  assert.throws(() => snapshot({ ...input, INPUT_FIRST: "" }), /missing or oversized/);
  assert.throws(() => snapshot({ ...input, INPUT_FIRST: input.INPUT_FIRST + "!" }), /encoding/);
  assert.throws(() => snapshot({ ...input, INPUT_SHA256: "0".repeat(64) }), /digest/);
  assert.throws(() => snapshot({ ...input, INPUT_COMMIT: "0".repeat(40) }), /selected source/);
});
