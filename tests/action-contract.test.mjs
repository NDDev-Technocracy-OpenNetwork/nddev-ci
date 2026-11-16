import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// actionlint does not read actions and workflows referenced with $/, so this test checks what it
// would: every call passes only declared inputs and every required one.
const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

// The names under a top-level or nested `inputs:` block, with whether each is required. An action
// without the block takes no inputs.
function declared(source, indent) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `${" ".repeat(indent)}inputs:`);
  const inputs = new Map();
  if (start === -1) return inputs;
  let current;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    const depth = line.length - line.trimStart().length;
    if (depth <= indent) break;
    const name = line.match(new RegExp(`^ {${indent + 2}}([a-z0-9-]+):$`));
    if (name) inputs.set((current = name[1]), false);
    else if (current && /^\s+required: true$/.test(line)) inputs.set(current, true);
  }
  return inputs;
}

// Every `uses: $/...` in a file, with the keys of its `with:` block.
function calls(path) {
  const lines = read(path).split("\n");
  const found = [];
  lines.forEach((line, index) => {
    const call = line.match(/^(\s*)(?:- )?uses: \$\/(\S+)$/);
    if (!call) return;
    const indent = call[1].length + (line.trimStart().startsWith("- ") ? 2 : 0);
    const keys = [];
    let inWith = false;
    for (const next of lines.slice(index + 1)) {
      if (next.trim() === "" || next.trimStart().startsWith("#")) continue;
      const depth = next.length - next.trimStart().length;
      if (depth < indent || (depth === indent && next.trimStart().startsWith("- "))) break;
      if (depth === indent) inWith = next.trim() === "with:";
      else if (inWith && depth === indent + 2) keys.push(next.trim().split(":")[0]);
    }
    found.push({ path, line: index + 1, target: call[2], keys });
  });
  return found;
}

const files = [
  ...readdirSync(new URL(".github/workflows/", root)).map((name) => `.github/workflows/${name}`),
  ...readdirSync(new URL("actions/", root)).map((name) => `actions/${name}/action.yml`),
];
const all = files.flatMap(calls);

test("every $/ call passes only declared inputs and each required one", () => {
  assert.ok(all.length > 40, `${all.length} calls`);
  for (const { path, line, target, keys } of all) {
    const where = `${path}:${line} ${target}`;
    const workflow = target.startsWith(".github/workflows/");
    const inputs = workflow ? declared(read(target), 4) : declared(read(`${target}/action.yml`), 0);
    for (const key of keys) assert.ok(inputs.has(key), `${where} passes undeclared ${key}`);
    for (const [name, required] of inputs)
      if (required) assert.ok(keys.includes(name), `${where} omits required ${name}`);
  }
});

test("check and recipe begin with prepare and end with complete", () => {
  for (const workflow of ["check.yml", "recipe.yml"]) {
    const targets = all
      .filter((call) => call.path === `.github/workflows/${workflow}` && call.target.startsWith("actions/"))
      .map((call) => call.target);
    assert.equal(targets[0], "actions/prepare", workflow);
    assert.equal(targets.filter((target) => target === "actions/prepare").length, 1, workflow);
    assert.equal(targets.at(-1), "actions/complete", workflow);
  }
});

// A skipped job still creates a GitHub check. Its optional name must follow the same predicate
// as execution; real work keeps its required context. Actual event transitions qualify this on
// GitHub as well, because source assertions alone do not prove skipped-name evaluation.
function jobContract(workflow, id) {
  const source = read(`.github/workflows/${workflow}`);
  const block = source.split(`\n  ${id}:\n`)[1]?.split(/\n  [a-z][a-z0-9-]*:\n/)[0];
  assert.ok(block, `${workflow}:${id} exists`);
  const value = (name) => block.match(new RegExp(`^    ${name}: (.+)$`, "m"))?.[1];
  return {name: value("name"), condition: value("if")};
}

test("unrelated labels cannot own the mandatory native context", () => {
  const {name, condition} = jobContract("check.yml", "check");
  assert.equal(condition, "github.event.action != 'labeled' || github.event.label.name == 'runner:github'");
  assert.equal(name,
    `\${{ (${condition}) && (github.event_name == 'pull_request' && 'short check' || 'full check') || 'ignored label' }}`,
    "unrelated label must not own the mandatory short-check context");
});

test("non-executing merge stops cannot own the mandatory context", () => {
  const {name, condition} = jobContract("merge-stops.yml", "merge-stops");
  assert.equal(condition, "github.event_name == 'pull_request' && (github.event.action != 'labeled' || github.event.label.name == 'runner:github')");
  assert.equal(name, `\${{ (${condition}) && 'merge stops' || 'ignored merge stops' }}`,
    "non-executing merge stops must not own the mandatory context");
});
