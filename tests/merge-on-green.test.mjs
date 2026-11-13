import assert from "node:assert/strict";
import test from "node:test";
import { selectMerge } from "../lib/merge-on-green.mjs";

const repository = "fixture/project";
const sha = "a".repeat(40);
const pull = (fields = {}) => ({number: 7, state: "open", draft: false, title: "chore: update", labels: [{name: "merge-on-green"}],
  head: {sha, ref: "renovate/x", repo: {full_name: repository}}, base: {ref: "dev", repo: {full_name: repository}}, ...fields});
const run = (name, conclusion = "success", status = "completed") => ({name, status, conclusion});

function api({pulls = [pull()], runs = [run("check / short check")], status = {total_count: 0, state: "pending"}}) {
  return {json: async (method, route) => {
    if (route.includes("/pulls")) return pulls;
    if (route.includes("/check-runs")) return {check_runs: runs};
    if (route.endsWith("/status")) return status;
    throw new Error(route);
  }};
}
const select = (github, extra = {}) => selectMerge(github, {repository, sha, self: "merge on green", ...extra});

test("a labelled pull request whose checks all passed is ready", async () => {
  const result = await select(api({runs: [run("check / short check"), run("check / merge-stops / merge stops"), run("macos", "skipped"), run("merge on green", null, "in_progress")]}));
  assert.equal(result.state, "ready");
  assert.equal(result.number, 7);
  assert.equal(result.base, "dev");
});

test("a running or failed check holds the merge", async () => {
  assert.equal((await select(api({runs: [run("a"), run("b", null, "queued")]}))).state, "pending");
  assert.equal((await select(api({runs: [run("a"), run("b", "failure")]}))).state, "failed");
  assert.equal((await select(api({runs: [run("a", "cancelled")]}))).state, "failed");
});

test("only the merge job itself is not enough", async () => {
  assert.equal((await select(api({runs: [run("merge on green", null, "in_progress")]}))).state, "pending");
});

test("no label, a draft, a fork or a moved head selects nothing", async () => {
  for (const fields of [{labels: []}, {draft: true}, {head: {sha, ref: "x", repo: {full_name: "other/fork"}}},
    {head: {sha: "b".repeat(40), ref: "x", repo: {full_name: repository}}}, {state: "closed"}])
    assert.equal((await select(api({pulls: [pull(fields)]}))).state, "none");
});

test("a failing commit status holds the merge", async () => {
  assert.equal((await select(api({status: {total_count: 1, state: "failure"}}))).state, "failed");
  assert.equal((await select(api({status: {total_count: 1, state: "success"}}))).state, "ready");
});

test("malformed input is refused", async () => {
  await assert.rejects(selectMerge(api({}), {repository: "bad", sha}));
  await assert.rejects(selectMerge(api({}), {repository, sha: "short"}));
});
