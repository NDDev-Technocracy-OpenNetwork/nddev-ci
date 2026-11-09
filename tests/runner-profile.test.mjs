import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { managedRunner } from "../lib/runner-profile.mjs";
import { main } from "../actions/runner-profile/run.mjs";

test("SDK ownership follows the runner unless an external provider is explicit", () => {
  assert.equal(managedRunner("github-hosted"), false);
  assert.equal(managedRunner("self-hosted"), true);
  assert.equal(managedRunner("self-hosted", "false"), false);
  assert.equal(managedRunner("self-hosted", "true"), true);
  for (const [kind, declared] of [[undefined, "false"], ["unknown", ""], ["self-hosted", "yes"]])
    assert.throws(() => managedRunner(kind, declared));
});

test("one profile output drives all bootstrap and managed paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "runner-profile-"));
  try {
    const file = path.join(root, "outputs");
    assert.equal(main({RUNNER_ENVIRONMENT: "self-hosted", INPUT_EXTERNAL: "true", GITHUB_OUTPUT: file}), false);
    assert.equal(readFileSync(file, "utf8"), "managed=false\nbootstrap=true\n");
    assert.throws(() => main({RUNNER_ENVIRONMENT: "self-hosted", INPUT_EXTERNAL: "yes", GITHUB_OUTPUT: file}));
  } finally { rmSync(root, {recursive: true, force: true}); }
});
