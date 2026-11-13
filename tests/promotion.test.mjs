import assert from "node:assert/strict";
import test from "node:test";
import { maxCommits, selectPromotion } from "../lib/promotion.mjs";

const repository = "fixture/library";
const workflowPath = ".github/workflows/ci.yml";
const sha = (n) => String(n).repeat(40).slice(0, 40);
const started = new Date(Date.now() - 10000).toISOString();
let id = 0;
const run = (head, fields = {}) => ({id: ++id, run_number: id, run_attempt: 1, head_sha: head, head_branch: "dev",
  event: "push", path: workflowPath, status: "completed", conclusion: "success", run_started_at: started,
  repository: {full_name: repository}, head_repository: {full_name: repository}, ...fields});

// A GitHub API of one comparison and the push runs of each commit.
function api({ahead, behind = 0, runs = {}}) {
  const calls = [];
  return {calls, json: async (method, route) => {
    calls.push(route);
    if (route.startsWith(`/repos/${repository}/compare/main...dev`))
      return {ahead_by: ahead.length, behind_by: behind, total_commits: ahead.length, commits: ahead.map((s) => ({sha: s}))};
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
  assert.equal(github.calls.length, 2, "it stops at the first passed commit from the newest");
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

test("main ahead of dev, an unbounded gap and malformed input are refused", async () => {
  await assert.rejects(select(api({ahead: [sha(1)], behind: 1})), /only moves main forward/);
  const many = Array.from({length: maxCommits + 1}, (_, n) => n.toString(16).padStart(40, "0"));
  await assert.rejects(select(api({ahead: many})), /promote by hand/);
  await assert.rejects(selectPromotion(api({ahead: []}), {repository, workflowPath, source: "dev", target: "dev"}), /two different/);
  await assert.rejects(selectPromotion(api({ahead: []}), {repository: "bad", workflowPath}), /exact repository/);
});
