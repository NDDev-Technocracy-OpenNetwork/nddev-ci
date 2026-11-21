import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

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

// The lines of one job of a workflow.
function lines(workflow, id) {
  const source = read(`.github/workflows/${workflow}`).split("\n");
  const start = source.indexOf(`  ${id}:`);
  const end = source.findIndex((line, index) => index > start && /^  [a-z][a-z0-9-]*:$/.test(line));
  return [start + 1, end === -1 ? source.length : end];
}

test("the project's command jobs begin with prepare and end with complete", () => {
  for (const [workflow, id] of [["check.yml", "check"], ["recipe.yml", "recipe"]]) {
    const [start, end] = lines(workflow, id);
    const targets = all
      .filter((call) => call.path === `.github/workflows/${workflow}` && call.target.startsWith("actions/") &&
        call.line > start && call.line <= end)
      .map((call) => call.target);
    assert.equal(targets[0], "actions/prepare", workflow);
    assert.equal(targets.filter((target) => target === "actions/prepare").length, 1, workflow);
    assert.equal(targets.at(-1), "actions/complete", workflow);
  }
});

// Real GitHub event transitions also qualify the required-check contract; evaluating the source
// expressions alone does not establish protected acceptance.
function jobContract(workflow, id) {
  const source = read(`.github/workflows/${workflow}`);
  const block = source.split(`\n  ${id}:\n`)[1]?.split(/\n  [a-z][a-z0-9-]*:\n/)[0];
  assert.ok(block, `${workflow}:${id} exists`);
  const value = (name) => block.match(new RegExp(`^    ${name}: (.+)$`, "m"))?.[1];
  const concurrency = block.match(/\n    concurrency:\n      group: (.+)\n      cancel-in-progress: (.+)/);
  return {name: value("name"), condition: value("if"), concurrency, matrix: block.match(/\n        part: (.+)/)?.[1]};
}

// A job's name, condition or matrix as GitHub evaluates it, for an event and the plan's outputs.
function evaluateJob(expression, github, needs = {plan: {result: "skipped", outputs: {}}}) {
  if (expression === undefined) return true;
  const context = {github, needs, cancelled: () => false, fromJSON: JSON.parse};
  return runInNewContext(expression.startsWith("$") ? expression.slice(3, -2) : expression, context);
}
function checkName(github, needs) {
  const contract = jobContract("check.yml", "check");
  const [part] = evaluateJob(contract.matrix, github, needs);
  return runInNewContext(contract.name.slice(3, -2), {matrix: {part}});
}

test("subscribed pull-request labels run the actual required workflows with stable names", () => {
  const execute = (expression, github) => evaluateJob(expression, github);
  for (const action of ["opened", "synchronize", "edited", "labeled"]) {
    for (const label of ["merge-on-green", "runner:github", "documentation"]) {
      const github = {event_name: "pull_request", event: {action, label: {name: label}}};
      for (const [workflow, id] of [
        ["check.yml", "check"], ["check.yml", "merge-stops"],
        ["merge-stops.yml", "merge-stops"], ["recipe.yml", "recipe"], ["image.yml", "image"],
      ]) assert.equal(execute(jobContract(workflow, id).condition, github), true, workflow + ":" + action + ":" + label);
      assert.equal(checkName(github), "short check");
      assert.equal(execute(jobContract("merge-stops.yml", "merge-stops").name, github), "merge stops");
    }
  }
  const push = {event_name: "push", event: {}};
  const whole = {plan: {result: "success", outputs: {matrix: '[{"label":"full check","group":"verify","argv":["verify"]}]'}}};
  assert.equal(evaluateJob(jobContract("check.yml", "check").condition, push, whole), true);
  assert.equal(checkName(push, whole), "full check");
  assert.equal(evaluateJob(jobContract("check.yml", "check").condition, push, {plan: {result: "failure", outputs: {}}}), false);
  for (const workflow of ["check.yml", "merge-stops.yml"])
    assert.equal(execute(jobContract(workflow, "merge-stops").condition, push), false);
  assert.equal(execute(jobContract("merge-stops.yml", "merge-stops").name, push), "ignored merge stops");
});

test("retained checks and merge stops keep separate groups for every run", () => {
  function evaluate(value, github, retain, group = "short") {
    const inputs = { retain, hosted: "ubuntu-24.04" };
    const format = (template, value) => template.replace("{0}", value);
    return value.replace(/\$\{\{ (.*?) \}\}/g, (_, expression) =>
      String(runInNewContext(expression
        .replaceAll("inputs.retain-runs", "inputs.retain")
        .replaceAll("inputs.hosted-runner", "inputs.hosted"), { github, inputs, format, matrix: { part: { group } } })),
    );
  }

  const github = {
    workflow: "ci", ref: "refs/pull/8/merge", event_name: "pull_request",
    event: { pull_request: { number: 8 } },
  };
  for (const [workflow, job] of [["check.yml", "check"], ["merge-stops.yml", "merge-stops"]]) {
    const [, group, cancel] = jobContract(workflow, job).concurrency;
    const first = { ...github, run_id: "101" };
    const second = { ...github, run_id: "102" };
    assert.equal(evaluate(group, first, false), evaluate(group, second, false), workflow);
    assert.equal(evaluate(cancel, first, false), "true", workflow);
    assert.notEqual(evaluate(group, first, true), evaluate(group, second, true), workflow);
    assert.equal(evaluate(cancel, first, true), "false", workflow);
  }

  const [, group, cancel] = jobContract("check.yml", "check").concurrency;
  const firstPush = { ...github, ref: "refs/heads/dev", event_name: "push", run_id: "103" };
  const nextPush = { ...firstPush, run_id: "104" };
  assert.equal(evaluate(group, firstPush, false), evaluate(group, nextPush, false));
  assert.equal(evaluate(cancel, firstPush, false), "false");
  assert.notEqual(evaluate(group, firstPush, true), evaluate(group, nextPush, true));
  assert.equal(evaluate(cancel, firstPush, true), "false");
  // Each part of a full check queues behind the same part of the run before it, not behind others.
  assert.notEqual(evaluate(group, firstPush, false, "test"), evaluate(group, firstPush, false, "image"));
  assert.equal(evaluate(group, firstPush, false, "test"), evaluate(group, nextPush, false, "test"));
  assert.match(read(".github/workflows/check.yml"),
    /uses: \$\/\.github\/workflows\/merge-stops\.yml\n    with:\n      retain-runs: \$\{\{ inputs\.retain-runs \}\}/);
});
