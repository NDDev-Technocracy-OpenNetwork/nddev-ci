import assert from "node:assert/strict";
import test from "node:test";
import { dailyEnabled, dailyPublication } from "../lib/release-cadence.mjs";
import { selectDailyPromotion } from "../lib/promotion.mjs";
const repository = "fixture/library", sha = "a".repeat(40), prior = "b".repeat(40);
const now = new Date("2026-11-16T12:00:00Z");
const published = (fields = {}) => ({id: 1, tag_name: "v1.0.0", draft: false, published_at: "2026-11-15T20:00:00Z", ...fields});
function api(releases, {head = sha, tagSource = prior, comparison = []} = {}) {
  const calls = [];
  return {calls, async json(method, route) {
    assert.equal(method, "GET", "selection may never mutate a repository");
    calls.push(route);
    if (route.includes("/releases?")) return typeof releases === "function" ? releases(route) : releases;
    if (route.includes("/git/ref/tags/")) return {ref: "refs/tags/" + decodeURIComponent(route.split("/").at(-1)), object: {type: "commit", sha: tagSource}};
    if (route.includes("/git/ref/heads/")) return {ref: "refs/heads/main", object: {type: "commit", sha: head}};
    if (route.includes("/compare/")) return {ahead_by: comparison.length, behind_by: 0, total_commits: comparison.length, commits: comparison.map((sha) => ({sha}))};
    if (route.includes("/workflows/")) return {total_count: 0, workflow_runs: []};
    assert.fail(route);
  }};
}
const state = (github, options = {}) => dailyPublication(github, {repository, sha, now, ...options});
test("daily publication holds a second new release but permits an exact published replay", async () => {
  const releases = [published({published_at: "2026-11-16T08:57:07Z"})];
  assert.equal((await state(api(releases))).state, "held");
  assert.equal((await state(api(releases, {tagSource: sha}), {tag: "v1.0.0"})).state, "replay");
  await assert.rejects(state(api(releases), {tag: "v1.0.0"}), /another source/);
});
test("the actual UTC publication date governs delayed schedules and the midnight boundary", async () => {
  const releases = [published({published_at: "2026-11-15T23:53:10Z"})];
  assert.equal((await state(api(releases), {now: new Date("2026-11-15T23:59:59Z")})).state, "held");
  assert.equal((await state(api(releases), {now: new Date("2026-11-16T00:00:00Z")})).state, "ready");
  assert.equal((await state(api([published({draft: true, published_at: null})]))).state, "ready");
});
test("pagination accounts for an older-created release published today and rejects incomplete inventories", async () => {
  const page = Array.from({length: 100}, (_, index) => published({id: index + 1, tag_name: `v1.0.${index}`}));
  const github = api((route) => route.endsWith("page=1") ? page : [published({id: 101, tag_name: "v1.0.100", published_at: "2026-11-16T01:00:00Z"})]);
  assert.equal((await state(github)).state, "held");
  assert.equal(github.calls.length, 2);
  await assert.rejects(state(api(() => page)), /repeated identity/);
  let index = 0;
  await assert.rejects(state(api(() => Array.from({length: 100}, () => published({id: ++index, tag_name: `v1.0.${index}`})))), /exceeds its bound/);
});
test("malformed metadata or a future clock cannot silently release", async () => {
  for (const releases of [null, [published({id: 0})], [published({tag_name: 42})], [published({draft: "false"})],
    [published({published_at: "2026-11-17T00:00:00Z"})], [published({published_at: "2026-02-30T00:00:00Z"})], [published({published_at: "unknown"})], [published(), published()]])
    await assert.rejects(state(api(releases)));
  await assert.rejects(state(api([]), {now: new Date("invalid")}));
  assert.equal(dailyEnabled("false"), false); assert.equal(dailyEnabled("true"), true);
  assert.throws(() => dailyEnabled("yes"));
});
test("daily promotion resumes unpublished main without advancing it or borrowing dev checks", async () => {
  const github = api([published()]);
  assert.deepEqual(await selectDailyPromotion(github, {repository, workflowPath: ".github/workflows/ci.yml"}, now), {state: "release_pending", sha});
  assert.ok(github.calls.every((route) => !route.includes("/compare/") && !route.includes("/workflows/")));
});
test("a no-change day is a no-op, a consumed day holds, and a new unchecked source stays unchecked", async () => {
  const options = {repository, workflowPath: ".github/workflows/ci.yml"};
  assert.equal((await selectDailyPromotion(api([published()], {tagSource: sha}), options, now)).state, "current");
  const held = api([published({published_at: "2026-11-16T09:00:00Z"})], {tagSource: sha});
  assert.equal((await selectDailyPromotion(held, options, now)).state, "held");
  assert.ok(held.calls.every((route) => !route.includes("/compare/")));
  assert.equal((await selectDailyPromotion(api([published()], {tagSource: sha, comparison: [prior]}), options, now)).state, "unchecked");
});

test("valid historical release tags retain their identity without changing numeric version selection", async () => {
  const legacy = published({tag_name: "nddev-ci-v0.6.25"});
  assert.equal((await state(api([legacy]))).state, "ready");
  assert.equal((await state(api([{...legacy, published_at: "2026-11-16T08:00:00Z"}]))).state, "held");
  assert.equal((await state(api([legacy], {tagSource: sha}), {tag: legacy.tag_name})).state, "replay");
  for (const name of ["", "bad\nname", "bad name", "a".repeat(1025)])
    await assert.rejects(state(api([published({tag_name: name})])));
});
