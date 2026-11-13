import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// check.yml and recipe.yml read private sources through prepare: the same read inputs and secrets,
// handed over the same way.
function text(workflow) {
  return readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8");
}

function declared(workflow) {
  const source = text(workflow);
  const start = source.indexOf("      read-app-client-id:\n");
  const end = source.indexOf("      read-repositories:\n", start);
  const after = source.indexOf("        default:", end);
  const secrets = source.slice(source.indexOf("    secrets:\n"), source.indexOf("\npermissions:"));
  return [source.slice(start, source.indexOf("\n", after)), secrets.trimEnd()];
}

function handed(workflow) {
  return text(workflow).split("\n").filter((line) => /^ {10}read-(keys|repositories|app-[a-z-]+): /.test(line));
}

test("recipe.yml takes check.yml's read inputs and secrets", () => {
  assert.deepEqual(declared("recipe.yml"), declared("check.yml"));
});

test("both workflows hand prepare the same read inputs and secrets", () => {
  assert.equal(handed("check.yml").length, 5);
  assert.deepEqual(handed("recipe.yml"), handed("check.yml"));
});
