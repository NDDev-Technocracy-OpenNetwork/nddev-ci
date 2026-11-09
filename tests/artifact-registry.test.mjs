import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registry, main } from "../actions/artifact-registry/run.mjs";

test("an artifact registry is optional and explicit input takes precedence", () => {
  assert.equal(registry({}), "");
  assert.equal(registry({ NDDEV_CI_ARTIFACT_REGISTRY: "http://127.0.0.1:8080/" }), "http://127.0.0.1:8080");
  assert.equal(registry({ INPUT_URL: "https://example.com/cache/", NDDEV_CI_ARTIFACT_REGISTRY: "invalid" }), "https://example.com/cache");
});

test("registry configuration cannot carry credentials or environment-file entries", () => {
  for (const url of ["relative", "file:///tmp/cache", "https://user:secret@example.com", "https://example.com?token=secret", "https://example.com/#fragment", "https://example.com\nOTHER=value", " https://example.com"])
    assert.throws(() => registry({ INPUT_URL: url }), /Artifact registry/);
});

test("hosted preparation publishes an empty optional registry without private state", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-registry-"));
  const file = path.join(directory, "environment");
  try {
    main({ GITHUB_ENV: file });
    assert.equal(readFileSync(file, "utf8"), "NDDEV_CI_ARTIFACT_REGISTRY=\n");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
