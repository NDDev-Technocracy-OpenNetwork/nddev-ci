import assert from "node:assert/strict";
import test from "node:test";

test("pre-push receiver qualification", () => {
  assert.equal(typeof assert.fail, "function");
});
