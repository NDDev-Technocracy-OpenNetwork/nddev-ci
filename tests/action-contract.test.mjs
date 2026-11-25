import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const anchors = new Map();
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
      if (depth === indent) {
        const withBlock = next.trim().match(/^with:(?: ([&*])([a-z0-9-]+))?$/);
        inWith = Boolean(withBlock && withBlock[1] !== "*");
        if (withBlock?.[1] === "&") anchors.set(withBlock[2], keys);
        if (withBlock?.[1] === "*") {
          assert.ok(anchors.has(withBlock[2]), `${path} uses an unknown input anchor ${withBlock[2]}`);
          keys.push(...anchors.get(withBlock[2]));
        }
      } else if (inWith && depth === indent + 2) {
        keys.push(next.trim().split(":")[0]);
      }
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
  const value = (name) => {
    const match = block.match(new RegExp(`^    ${name}: (>-(?:\\n      .+)+|.+)$`, "m"));
    if (!match) return undefined;
    return match[1].startsWith(">-")
      ? match[1].slice(2).split("\n").map((line) => line.trim()).filter(Boolean).join(" ")
      : match[1];
  };
  const concurrency = block.match(/\n    concurrency:\n(?:      #.*\n)*      group: (.+)\n      cancel-in-progress: (.+)/);
  return {name: value("name"), condition: value("if"), concurrency, matrix: block.match(/\n        part: ([^\n]+(?:\n {10}[^\n]+)*)/)?.[1]};
}

function workflowConcurrency(path) {
  const match = read(path).match(/\nconcurrency:\n(?:  #.*\n)*  group: (.+)\n  cancel-in-progress: (.+)/);
  assert.ok(match, `${path} workflow concurrency exists`);
  return match;
}

// A job's name, condition or matrix as GitHub evaluates it, for an event and the plan's outputs.
function evaluateJob(expression, github, needs = {plan: {result: "skipped", outputs: {}}}, opts = {}) {
  if (expression === undefined) return true;
  const options = typeof opts === "boolean" ? {whole: opts} : opts;
  const inputs = {
    "whole-full-check": Boolean(options.whole),
    "split-full-check": Boolean(options.split),
    "part-runners": options.partRunners ?? "{}",
    "inline-merge-stops": Boolean(options.inlineStops),
    "retain-separate-merge-stops": Boolean(options.retainSeparateStops),
    "merge-group-full-check": Boolean(options.mergeGroupFull),
    "registry-commit": options.registryCommit ?? "",
    "sparse-checkout": options.sparseCheckout ?? "",
    "runner-profile": options.runnerProfile ?? "",
    runner: options.runner ?? "nddev-linux-standart",
  };
  const context = {
    github, needs, inputs, cancelled: () => false, fromJSON: JSON.parse,
    contains: (values, value) => Array.isArray(values) && values.includes(value),
    format: (template, arg) => template.replace("{0}", arg),
  };
  const source = (expression.startsWith("$") ? expression.slice(3, -2) : expression)
    .replaceAll("github.event.pull_request.labels.*.name", "(github.event?.pull_request?.labels || []).map((l) => l.name ?? l)")
    .replaceAll("inputs.whole-full-check", "inputs['whole-full-check']")
    .replaceAll("inputs.split-full-check", "inputs['split-full-check']")
    .replaceAll("inputs.inline-merge-stops", "inputs['inline-merge-stops']")
    .replaceAll("inputs.retain-separate-merge-stops", "inputs['retain-separate-merge-stops']")
    .replaceAll("inputs.merge-group-full-check", "inputs['merge-group-full-check']")
    .replaceAll("inputs.registry-commit", "inputs['registry-commit']")
    .replaceAll("inputs.sparse-checkout", "inputs['sparse-checkout']")
    .replaceAll("inputs.runner-profile", "inputs['runner-profile']");
  return runInNewContext(source, context);
}
function checkName(github, needs, opts) {
  const contract = jobContract("check.yml", "check");
  const [part] = evaluateJob(contract.matrix, github, needs, opts);
  return runInNewContext(contract.name.slice(3, -2), {matrix: {part}});
}

test("subscribed pull-request labels run the actual required workflows with stable names", () => {
  const execute = (expression, github) => evaluateJob(expression, github);
  for (const action of ["opened", "synchronize", "edited", "labeled"]) {
    for (const label of ["merge-on-green", "runner:github", "runner:github:linux-arm64", "documentation"]) {
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
  assert.equal(evaluateJob(jobContract("check.yml", "check").condition, push, whole, {split: true}), true);
  assert.equal(evaluateJob(jobContract("check.yml", "check").condition, push, {plan: {result: "success", outputs: {matrix: "[]"}}}, {split: true}), false);
  assert.equal(checkName(push, whole, {split: true}), "full check");
  assert.equal(evaluateJob(jobContract("check.yml", "check").condition, push, {plan: {result: "failure", outputs: {}}}, {split: true}), false);
  for (const workflow of ["check.yml", "merge-stops.yml"])
    assert.equal(execute(jobContract(workflow, "merge-stops").condition, push), false);
  assert.equal(execute(jobContract("merge-stops.yml", "merge-stops").name, push), "ignored merge stops");
});

test("full check runs in one job by default and splits only on split-full-check or part-runners", () => {
  const plan = jobContract("check.yml", "plan");
  const check = jobContract("check.yml", "check");
  const join = jobContract("check.yml", "full-check");
  const needs = {plan: {result: "skipped", outputs: {}}, check: {result: "success"}};
  for (const event_name of ["push", "workflow_dispatch"]) {
    const github = {event_name};
    // Default single-host full check skips plan and join jobs while keeping the full check name.
    assert.equal(evaluateJob(plan.condition, github, needs), false);
    assert.equal(evaluateJob(check.condition, github, needs), true);
    assert.equal(checkName(github, needs), "full check");
    assert.deepEqual(evaluateJob(check.matrix, github, needs), [
      {label: "full check", group: "verify", argv: ["verify"]},
    ]);
    assert.equal(evaluateJob(join.condition, github, needs), false);

    // Explicit whole-full-check stays single-job even with split-full-check or part-runners.
    assert.equal(evaluateJob(plan.condition, github, needs, {whole: true, split: true}), false);
    assert.equal(evaluateJob(check.condition, github, needs, {whole: true, split: true}), true);

    // Opt-in split-full-check or non-empty part-runners activates plan -> matrix -> join.
    for (const opts of [{split: true}, {partRunners: '{"check":"nddev-linux-light"}'}]) {
      assert.equal(evaluateJob(plan.condition, github, needs, opts), true);
      assert.equal(evaluateJob(check.condition, github, needs, opts), false);
    }
  }
  assert.equal(checkName({event_name: "pull_request"}, needs), "short check");
  assert.equal(evaluateJob(jobContract("check.yml", "merge-stops").condition, {event_name: "pull_request"}, needs, {inlineStops: true}), false);
  assert.equal(evaluateJob(jobContract("check.yml", "merge-stops").condition, {event_name: "pull_request"}, needs, {inlineStops: false}), true);
  assert.equal(evaluateJob(jobContract("check.yml", "merge-stops").condition, {event_name: "pull_request"}, needs, {inlineStops: true, retainSeparateStops: true}), true);

  // merge_group defaults to short check + merge-stops and can opt into full check without cancelling.
  const mg = {event_name: "merge_group", event: {merge_group: {base_sha: "a".repeat(40), head_sha: "b".repeat(40)}}};
  assert.equal(evaluateJob(plan.condition, mg, needs, {split: true}), false);
  assert.equal(evaluateJob(check.condition, mg, needs), true);
  assert.equal(checkName(mg, needs), "short check");
  assert.equal(evaluateJob(jobContract("check.yml", "merge-stops").condition, mg, needs), true);
  assert.equal(evaluateJob(jobContract("merge-stops.yml", "merge-stops").condition, mg, needs), true);
  assert.equal(evaluateJob(jobContract("merge-stops.yml", "merge-stops").name, mg, needs), "merge stops");
  assert.equal(evaluateJob(plan.condition, mg, needs, {split: true, mergeGroupFull: true}), false);
  assert.deepEqual(evaluateJob(check.matrix, mg, needs, {mergeGroupFull: true}), [
    {label: "short check", group: "short", argv: ["verify"]},
  ]);
});

test("registry-project folds into check on private single-job Linux x64 managed runs and stays separate otherwise", () => {
  const reg = jobContract("check.yml", "registry-project");
  const pr = {
    event_name: "pull_request", repository: "o/r", ref: "refs/pull/1/merge",
    event: {repository: {private: true}, pull_request: {head: {repo: {full_name: "o/r"}}, labels: []}},
  };
  const devPush = {
    event_name: "push", repository: "o/r", ref: "refs/heads/dev",
    event: {repository: {private: true}},
  };
  const base = {registryCommit: "a".repeat(40), runner: "nddev-linux-standart", runnerProfile: "linux-x64"};
  // Folded into check (separate registry-project job skipped):
  assert.equal(evaluateJob(reg.condition, pr, {}, base), false);
  assert.equal(evaluateJob(reg.condition, devPush, {}, base), false);
  assert.equal(evaluateJob(reg.condition, pr, {}, {...base, runnerProfile: "", runner: "nddev-linux-small"}), false);
  // Stays a separate managed Linux x64 job when check is not guaranteed managed Linux x64 full checkout:
  assert.equal(evaluateJob(reg.condition, pr, {}, {...base, runner: "nddev-macos", runnerProfile: "macos-arm64"}), true);
  assert.equal(evaluateJob(reg.condition, pr, {}, {...base, runner: "nddev-linux-arm64", runnerProfile: "linux-arm64"}), true);
  assert.equal(evaluateJob(reg.condition, pr, {}, {...base, runner: "nddev-linux-light", runnerProfile: ""}), true);
  assert.equal(evaluateJob(reg.condition, pr, {}, {...base, sparseCheckout: "docs/"}), true);
  assert.equal(evaluateJob(reg.condition, devPush, {}, {...base, split: true}), true);
  assert.equal(evaluateJob(reg.condition, pr, {}, {...base, partRunners: '{"short":"nddev-linux-light"}'}), true);
  const hostedPr = {
    ...pr,
    event: {...pr.event, pull_request: {...pr.event.pull_request, labels: [{name: "runner:github"}]}},
  };
  assert.equal(evaluateJob(reg.condition, hostedPr, {}, base), true);
  const scopedHostedPr = {
    ...pr,
    event: {...pr.event, pull_request: {...pr.event.pull_request, labels: [{name: "runner:github:linux-x64"}]}},
  };
  assert.equal(evaluateJob(reg.condition, scopedHostedPr, {}, base), true);
});

test("workflow concurrency cancels superseded pull requests, queues branch pushes and honors retain-runs", () => {
  function evaluate(value, github, extra = {}) {
    const inputs = {
      retain: false, runner: "nddev-linux-standart", hosted: "ubuntu-24.04", profile: "linux-x64",
      workdir: ".", justfile: "justfile", recipe: "verify", arguments: "[]",
      image: "app", target: "", lock: "lock.json", context: "contour/source", ...extra,
    };
    const format = (template, arg) => template.replace("{0}", arg);
    return value.replace(/\$\{\{ (.*?) \}\}/g, (_, expression) =>
      String(runInNewContext(expression
        .replaceAll("inputs.retain-runs", "inputs.retain")
        .replaceAll("inputs.hosted-runner", "inputs.hosted")
        .replaceAll("inputs.runner-profile", "inputs.profile")
        .replaceAll("inputs.working-directory", "inputs.workdir")
        .replaceAll("inputs.lock-file", "inputs.lock"), {
          github, inputs, format, vars: { NDDEV_BRANCH_FALLBACK_ACTOR_ID: "42" },
        })),
    );
  }

  const event = { repository: { private: true } };
  const prBase = { workflow: "ci", ref: "refs/pull/8/merge", event_name: "pull_request", event };
  const prFirst = { ...prBase, run_id: "101" };
  const prSecond = { ...prBase, run_id: "102" };
  const prOther = { ...prBase, ref: "refs/pull/9/merge", run_id: "103" };
  const devFirst = { workflow: "ci", ref: "refs/heads/dev", event_name: "push", run_id: "104", sha: "aaa", event };
  const devSecond = { workflow: "ci", ref: "refs/heads/dev", event_name: "push", run_id: "105", sha: "bbb", event };

  // check.yml uses workflow-level concurrency so plan, registry-project, split check parts and join share one lease.
  assert.equal(jobContract("check.yml", "check").concurrency, null);
  const caller = workflowConcurrency("examples/ci.yml");
  const groupsSeen = new Set([evaluate(caller[1], prFirst)]);
  assert.equal(evaluate(caller[1], prFirst), evaluate(caller[1], prSecond));
  assert.equal(evaluate(caller[2], prFirst), "true");
  assert.equal(evaluate(caller[1], devFirst), evaluate(caller[1], devSecond));
  assert.equal(evaluate(caller[2], devFirst), "false");

  const hosted = {
    ...devSecond, event_name: "workflow_dispatch", actor_id: "42", actor: "scheduler[bot]",
    triggering_actor: "scheduler[bot]",
    event: { repository: { private: true }, inputs: { runner: "github", "runner-profile": "linux-x64" } },
  };
  for (const [, group, cancel] of [caller, workflowConcurrency(".github/workflows/check.yml")]) {
    assert.notEqual(evaluate(group, hosted), evaluate(group, devSecond));
    assert.notEqual(evaluate(group, hosted), evaluate(group, { ...hosted, sha: devFirst.sha }));
    assert.equal(evaluate(cancel, hosted), "false");
    assert.equal(evaluate(group, { ...hosted, actor_id: "13" }), evaluate(group, devSecond));
    assert.equal(evaluate(group, { ...hosted, triggering_actor: "operator" }), evaluate(group, devSecond));
  }

  const specs = [
    ["check.yml", workflowConcurrency(".github/workflows/check.yml"), { profile: "linux-arm64" }, true],
    ["recipe.yml", workflowConcurrency(".github/workflows/recipe.yml"), { arguments: '["backend"]' }, true],
    ["merge-stops.yml", jobContract("merge-stops.yml", "merge-stops").concurrency, { profile: "linux-arm64" }, false],
    ["image.yml", jobContract("image.yml", "image").concurrency, { target: "lab" }, true],
    ["select-registry-input.yml", workflowConcurrency(".github/workflows/select-registry-input.yml"), { lock: "other.json" }, true],
    ["source-version.yml", workflowConcurrency(".github/workflows/source-version.yml"), { context: "other/source" }, true],
  ];

  for (const [name, [, group, cancel], distinctInput, testsPush] of specs) {
    const g1 = evaluate(group, prFirst);
    assert.ok(!groupsSeen.has(g1), `${name} group must not collide with caller or sibling workflows`);
    groupsSeen.add(g1);
    assert.equal(g1, evaluate(group, prSecond), name);
    assert.notEqual(g1, evaluate(group, prOther), name);
    assert.notEqual(g1, evaluate(group, prFirst, distinctInput), name);
    assert.equal(evaluate(cancel, prFirst), "true", name);
    assert.notEqual(evaluate(group, prFirst, { retain: true }), evaluate(group, prSecond, { retain: true }), name);
    assert.equal(evaluate(cancel, prFirst, { retain: true }), "false", name);
    if (testsPush) {
      assert.equal(evaluate(group, devFirst), evaluate(group, devSecond), `${name} push queues on branch ref`);
      assert.equal(evaluate(cancel, devFirst), "false", `${name} push never cancels in-progress`);
      assert.notEqual(evaluate(group, devFirst, { retain: true }), evaluate(group, devSecond, { retain: true }), name);
      assert.equal(evaluate(cancel, devFirst, { retain: true }), "false", name);
    }
  }

  // Sibling recipe calls differing by recipe, working directory, runner or hosted runner stay distinct.
  const [, recipeGroup] = workflowConcurrency(".github/workflows/recipe.yml");
  for (const variant of [{ recipe: "other" }, { workdir: "sub" }, { justfile: "other.just" }, { runner: "nddev-macos" }, { hosted: "ubuntu-26.04-arm" }]) {
    assert.notEqual(evaluate(recipeGroup, prFirst), evaluate(recipeGroup, prFirst, variant));
  }

  // Security, release, promotion, registry and merge-on-green never cancel in-progress runs.
  const [, securityGroup, securityCancel] = workflowConcurrency(".github/workflows/security.yml");
  assert.equal(evaluate(securityGroup, devFirst), evaluate(securityGroup, devSecond));
  assert.equal(securityCancel, "false");
  for (const [workflow, job] of [["release.yml", "release"], ["promote.yml", "promote"], ["registry.yml", "publish"], ["merge-on-green.yml", "merge"]]) {
    assert.equal(jobContract(workflow, job).concurrency[2], "false", `${workflow}:${job} never cancels`);
  }
  assert.match(read(".github/workflows/promote.yml"),
    /if: github\.event_name != 'workflow_run' \|\| github\.event\.workflow_run\.conclusion != 'cancelled'/);

  assert.match(read(".github/workflows/check.yml"),
    /uses: \$\/\.github\/workflows\/merge-stops\.yml\n    with:\n      retain-runs: \$\{\{ inputs\.retain-runs \}\}/);
});

test("the split check identifies a deployment artifact from multiple paths or a glob", () => {
  const source = read(".github/workflows/check.yml");
  const [, afterStepName] = source.split("      - name: Deployment artifact of a part\n");
  const [step] = afterStepName.split("\n      - name:");
  const [, run] = step.split("        run: |\n");
  const script = run.split("\n").map((line) => line.slice(10)).join("\n");
  const work = mkdtempSync(join(tmpdir(), "nddev-ci-artifact-paths-"));
  const output = join(work, "output");
  try {
    mkdirSync(join(work, "dist"));
    writeFileSync(join(work, "dist", "release.json"), "{}");
    for (const artifact of ["dist", "absent\n dist\r\n", "absent\n dist/**/*.json"]) {
      const result = spawnSync("bash", ["-c", script], {
        cwd: work, env: { ...process.env, ARTIFACT: artifact, GITHUB_OUTPUT: output }, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, "utf8"), "left=true\n");
      rmSync(output);
    }
    const absent = spawnSync("bash", ["-c", script], {
      cwd: work, env: { ...process.env, ARTIFACT: "missing\n*.tgz", GITHUB_OUTPUT: output }, encoding: "utf8",
    });
    assert.equal(absent.status, 0, absent.stderr);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(work, {recursive: true, force: true});
  }
});
