import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { invocation, parseArguments } from "../actions/recipe/run.mjs";

test("retains exact argument boundaries and literal shell characters", () => {
  const expected = [
    "path with spaces",
    "$(must-stay-literal)",
    "مرحبا-Ә-测试",
    "--leading-option",
  ];
  assert.deepEqual(parseArguments(JSON.stringify(expected)), expected);
});
for (const value of [
  "{}",
  "[1]",
  "[null]",
  '"value"',
  '["\\u0000"]',
  "{",
  " ".repeat(65537),
]) {
  test("refuses malformed or unbounded arguments", () => {
    assert.throws(() => parseArguments(value));
  });
}
test("constructs argv for the selected justfile and refuses path escape", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "recipe-workspace-"));
  const outside = mkdtempSync(path.join(tmpdir(), "recipe-outside-"));
  try {
    mkdirSync(path.join(workspace, "project"));
    writeFileSync(
      path.join(workspace, "project", "justfile"),
      "check:\n    true\n",
    );
    writeFileSync(path.join(outside, "justfile"), "check:\n    true\n");
    const options = {
      workspace,
      directory: "project",
      recipe: "check",
      arguments: '["a b"]',
    };
    const result = invocation(options);
    assert.equal(result.cwd, realpathSync(path.join(workspace, "project")));
    assert.deepEqual(result.argv, [
      "--justfile",
      realpathSync(path.join(workspace, "project", "justfile")),
      "--",
      "check",
      "a b",
    ]);
    assert.throws(() => invocation({ ...options, directory: outside }));
    assert.throws(() => invocation({ ...options, recipe: "--evaluate" }));
    symlinkSync(
      outside,
      path.join(workspace, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(() => invocation({ ...options, directory: "escape" }));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
