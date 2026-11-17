import assert from "node:assert/strict";
import test from "node:test";
import { comparisonPageSize, selectPromotion } from "../lib/promotion.mjs";

const repository = "fixture/library";
const workflowPath = ".github/workflows/ci.yml";
const sha = (n) => n.toString(16).padStart(40, "0");
const started = new Date(Date.now() - 10000).toISOString();
let id = 0;
const run = (head, fields = {}) => ({id: ++id, run_number: id, run_attempt: 1, head_sha: head, head_branch: "dev",
  event: "push", path: workflowPath, status: "completed", conclusion: "success", run_started_at: started,
  repository: {full_name: repository}, head_repository: {full_name: repository}, ...fields});

// The external GitHub branch/comparison and exact-source workflow-run contract.
function api({ahead, behind = 0, runs = {}}) {
  const calls = [];
  return {calls, json: async (method, route) => {
    calls.push(route);
    const source = ahead.at(-1) ?? sha(0);
    if (route === "/repos/" + repository + "/branches/dev") return {name: "dev", commit: {sha: source}};
    if (route === "/repos/" + repository + "/branches/main") return {name: "main", commit: {sha: sha(0)}};
    if (route.startsWith("/repos/" + repository + "/compare/" + sha(0) + "..." + source)) {
      const page = Number(new URL(route, "https://api.invalid").searchParams.get("page"));
      return {ahead_by: ahead.length, behind_by: behind, total_commits: ahead.length,
        base_commit: {sha: sha(0)}, merge_base_commit: {sha: sha(0)},
        commits: ahead.slice((page - 1) * comparisonPageSize, page * comparisonPageSize).map((value) => ({sha: value}))};
    }
    const head = new URL(route, "https://api.invalid").searchParams.get("head_sha");
    const listed = runs[head] ?? [];
    return {total_count: listed.length, workflow_runs: listed};
  }};
}

const select = (github) => selectPromotion(github, {repository, workflowPath});

test("main moves to the newest dev commit whose push check passed", async () => {
  const github = api({ahead: [sha(1), sha(2), sha(3)], runs: {[sha(1)]: [run(sha(1))], [sha(3)]: [run(sha(3))]}});
  const result = await select(github);
  assert.equal(result.state, "ready");
  assert.equal(result.sha, sha(3));
  assert.equal(github.calls.filter(route => route.includes("/actions/workflows/")).length, 1, "it stops at the first passed commit from the newest");
});

test("a newer failed or running check is passed over for an older passed commit", async () => {
  const github = api({ahead: [sha(1), sha(2), sha(3)], runs: {
    [sha(1)]: [run(sha(1))],
    [sha(2)]: [run(sha(2), {conclusion: "failure"})],
    [sha(3)]: [run(sha(3), {status: "in_progress", conclusion: null})],
  }});
  const result = await select(github);
  assert.equal(result.sha, sha(1));
  assert.deepEqual(result.skipped.map((s) => s.state), ["pending", "failed"]);
});

test("an older passed attempt does not stand in for a newer failed one of the same commit", async () => {
  const passed = run(sha(2));
  const github = api({ahead: [sha(1), sha(2)], runs: {
    [sha(1)]: [run(sha(1))],
    [sha(2)]: [passed, {...passed, run_attempt: 2, conclusion: "failure"}],
  }});
  assert.equal((await select(github)).sha, sha(1));
});

test("nothing to promote and nothing checked are their own states", async () => {
  assert.equal((await select(api({ahead: []}))).state, "current");
  assert.equal((await select(api({ahead: [sha(1)], runs: {}}))).state, "unchecked");
});

test("main ahead of dev and malformed input are refused", async () => {
  await assert.rejects(select(api({ahead: [sha(1)], behind: 1})), /only moves main forward/);
  await assert.rejects(selectPromotion(api({ahead: []}), {repository, workflowPath, source: "dev", target: "dev"}), /two different/);
  await assert.rejects(selectPromotion(api({ahead: []}), {repository: "bad", workflowPath}), /exact repository/);
});

test("promotion requires every workflow for the exact commit and its newest attempt", async () => {
  for (const state of ["missing", "pending", "failed", "qualified"]) {
    const github = api({ahead: [sha(2)], runs: {[sha(2)]: [run(sha(2))]}});
    const original = github.json;
    github.json = async (method, route) => {
      if (!route.includes("/workflows/portable.yml/")) return original(method, route);
      let runs = [run(sha(2), {path: ".github/workflows/portable.yml"})];
      if (state === "missing") runs = [];
      if (state === "pending") runs[0] = {...runs[0], status: "in_progress", conclusion: null};
      if (state === "failed") runs = [runs[0], {...runs[0], run_attempt: 2, conclusion: "failure"}];
      return {total_count: runs.length, workflow_runs: runs};
    };
    const result = await selectPromotion(github, {repository, workflowPath, requiredWorkflows: "portable.yml"});
    assert.equal(result.state, state === "qualified" ? "ready" : "unchecked", state);
  }
});

test("a history beyond the old 250-commit limit selects the newest exact qualified source", async () => {
  const ahead = Array.from({length: 251}, (_, n) => sha(n + 1));
  const github = api({ahead, runs: {[ahead.at(-1)]: [run(ahead.at(-1))]}});
  const result = await select(github);
  assert.equal(result.sha, ahead.at(-1));
  assert.deepEqual(github.calls.filter(route => route.includes("/compare/")).map(route =>
    Number(new URL(route, "https://api.invalid").searchParams.get("page"))), [1, 3]);
  assert.equal(github.calls.filter(route => route.includes("/actions/workflows/")).length, 1);
});

test("older comparison pages are searched without truncating the qualified fallback", async () => {
  const ahead = Array.from({length: 251}, (_, n) => sha(n + 1));
  const github = api({ahead, runs: {[ahead[49]]: [run(ahead[49])]}});
  assert.equal((await select(github)).sha, ahead[49]);
  assert.deepEqual(github.calls.filter(route => route.includes("/compare/")).map(route =>
    Number(new URL(route, "https://api.invalid").searchParams.get("page"))), [1, 3, 2]);
  assert.equal(github.calls.filter(route => route.includes("/branches/")).length, 2);
});

test("an interrupted page read can resume selection without a mutation or a manual exit", async () => {
  const ahead = Array.from({length: 251}, (_, n) => sha(n + 1));
  const github = api({ahead, runs: {[ahead.at(-1)]: [run(ahead.at(-1))]}});
  const read = github.json;
  let interrupted = false;
  github.json = async (method, route) => {
    assert.equal(method, "GET");
    if (!interrupted && route.endsWith("&page=3")) {
      interrupted = true;
      throw new Error("connection lost");
    }
    return read(method, route);
  };
  await assert.rejects(select(github), /connection lost/);
  assert.equal((await select(github)).sha, ahead.at(-1));
});

test("incomplete, inconsistent and misanchored comparison pages refuse before qualification", async () => {
  for (const brokenPage of [1, 3]) for (const alter of [
    page => ({...page, total_commits: page.total_commits + 1}),
    page => ({...page, commits: []}),
    page => ({...page, base_commit: {sha: sha(9)}}),
    page => ({...page, commits: [{sha: sha(9)}]}),
  ]) {
    const ahead = Array.from({length: 251}, (_, n) => sha(n + 1));
    const github = api({ahead, runs: {[ahead.at(-1)]: [run(ahead.at(-1))]}});
    const read = github.json;
    github.json = async (method, route) => {
      const value = await read(method, route);
      return route.endsWith("&page=" + brokenPage) ? alter(value) : value;
    };
    await assert.rejects(select(github), /comparison/);
    assert.equal(github.calls.some(route => route.includes("/actions/workflows/")), false);
  }
});
