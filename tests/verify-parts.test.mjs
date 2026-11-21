import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../actions/plan/run.mjs";
import { matrix, plan } from "../lib/verify-parts.mjs";

// The planner reads what just itself dumps, so each case is a real justfile, run where just is: the
// library's check job has it, its bare native test jobs do not.
const withJust = {skip: spawnSync("just", ["--version"]).status === 0 ? false : "just is not on this runner's PATH"};
function dump(justfile, modules = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "verify-parts-"));
  try {
    writeFileSync(path.join(root, "justfile"), justfile);
    for (const [name, source] of Object.entries(modules)) writeFileSync(path.join(root, `${name}.just`), source);
    const result = spawnSync("just", ["--dump", "--dump-format", "json"], {cwd: root, encoding: "utf8"});
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}
const recipes = (...names) => names.map((name) => `${name}:\n    echo ${name}\n`).join("");

test("each dependency of a plain verify is a part, in verify's order", withJust, () => {
  const result = plan(dump(`verify: check test build\n${recipes("check", "test", "build")}`));
  assert.equal(result.split, true);
  assert.deepEqual(result.parts.map((part) => part.argv), [["check"], ["test"], ["build"]]);
  assert.deepEqual(matrix(result).map((job) => job.label), ["verify: check", "verify: test", "verify: build"]);
});

test("a part another part needs runs in that part's job, through any depth", withJust, () => {
  const result = plan(dump(`verify: check image test-image test-copy
check:
    echo check
image:
    echo image
test-image: image
    echo test
test-copy: load
    echo copy
load: image
    echo load
`));
  assert.deepEqual(result.parts.map((part) => part.name), ["check", "image + test-image + test-copy"]);
  assert.deepEqual(result.parts[1].argv, ["image", "test-image", "test-copy"]);
  assert.equal(result.parts[1].group, "image");
});

test("shared helpers of two parts do not join them", withJust, () => {
  const result = plan(dump(`verify: a b\na: db\n    echo a\nb: db\n    echo b\n${recipes("db")}`));
  assert.deepEqual(result.parts.map((part) => part.name), ["a", "b"]);
});

test("literal arguments and module recipes keep their own invocation", withJust, () => {
  const result = plan(dump(`mod tools\nverify: (test "unit") tools::lint\ntest scope:\n    echo {{scope}}\n`,
    {tools: "lint:\n    echo lint\n"}));
  assert.deepEqual(result.parts.map((part) => part.argv), [["test", "unit"], ["tools::lint"]]);
  assert.equal(result.parts[1].group, "tools--lint");
});

test("a verify that is more than independent parts runs whole", withJust, () => {
  const cases = [
    ["other:\n    echo\n", "has no verify"],
    [`verify: check\n${recipes("check")}`, "fewer than two"],
    [`verify: check test\n    echo after\n${recipes("check", "test")}`, "commands of its own"],
    [`verify mode: check test\n${recipes("check", "test")}`, "takes parameters"],
    [`verify: check && test\n${recipes("check", "test")}`, "after its own body"],
    [`x := "a"\nverify: check (test x)\ncheck:\n    echo\ntest m:\n    echo {{m}}\n`, "computed"],
    [`verify: check (test "--all")\ncheck:\n    echo\ntest m:\n    echo {{m}}\n`, "option-like"],
    [`verify: check (test "a")\ncheck:\n    echo\ntest *m:\n    echo {{m}}\n`, "variadic"],
    [`verify: a b\na: b\n    echo a\nb:\n    echo b\n`, "all need each other"],
  ];
  for (const [source, reason] of cases) {
    const result = plan(dump(source));
    assert.equal(result.split, false, reason);
    assert.match(result.reason, new RegExp(reason));
    assert.deepEqual(matrix(result), [{label: "full check", group: "verify", argv: ["verify"]}]);
  }
});

test("the plan step writes the jobs, honours a reason to run whole and survives an unreadable justfile", withJust, () => {
  const root = mkdtempSync(path.join(tmpdir(), "plan-step-"));
  try {
    const environment = (whole = "") => {
      for (const name of ["output", "summary"]) writeFileSync(path.join(root, name), "");
      return {INPUT_WHOLE: whole, GITHUB_OUTPUT: path.join(root, "output"), GITHUB_STEP_SUMMARY: path.join(root, "summary")};
    };
    const parts = JSON.stringify(dump(`verify: check test\n${recipes("check", "test")}`));
    main(environment(), () => ({status: 0, stdout: parts}));
    assert.match(readFileSync(path.join(root, "output"), "utf8"), /^split=true\nmatrix=\[\{"label":"verify: check"/);
    main(environment("the caller names reports"), () => assert.fail("a reason to run whole reads nothing"));
    assert.match(readFileSync(path.join(root, "output"), "utf8"), /^split=false\nmatrix=\[\{"label":"full check"/);
    assert.match(readFileSync(path.join(root, "summary"), "utf8"), /the caller names reports/);
    main(environment(), () => ({status: 1, stdout: ""}));
    assert.match(readFileSync(path.join(root, "summary"), "utf8"), /could not be read\n\n- `just verify`/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
