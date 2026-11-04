import assert from "node:assert/strict";
import test from "node:test";
import { checksum } from "./checksum.js";

test("checksum is stable", () => {
  assert.equal(checksum("ci"), 204);
  assert.equal(checksum(""), 0);
  assert.equal(checksum("ü"), 127);
});
test("checksum stays in one byte", () => {
  for (const sample of ["", "a", "the quick brown fox"]) {
    assert.ok(checksum(sample) >= 0 && checksum(sample) <= 255);
  }
});
