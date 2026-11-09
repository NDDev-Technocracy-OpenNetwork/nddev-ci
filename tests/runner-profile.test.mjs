import test from "node:test";
import assert from "node:assert/strict";
import { managedRunner } from "../lib/runner-profile.mjs";

test("SDK ownership follows the runner unless an external provider is explicit", () => {
  assert.equal(managedRunner("github-hosted"), false);
  assert.equal(managedRunner("self-hosted"), true);
  assert.equal(managedRunner("self-hosted", "false"), false);
  assert.equal(managedRunner("self-hosted", "true"), true);
  for (const [kind, declared] of [[undefined, "false"], ["unknown", ""], ["self-hosted", "yes"]])
    assert.throws(() => managedRunner(kind, declared));
});
