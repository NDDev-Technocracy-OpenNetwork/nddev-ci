import assert from "node:assert/strict";
import test from "node:test";
import { replacePush } from "../tools/hosted-fallback.mjs";

const repository = "owner/project";
const sha = "a".repeat(40);
const expected = {repository, workflow:"ci.yml", branch:"dev", sha, profile:"linux-x64", pushId:11, actorId:"42"};
const push = {
  id:11, event:"push", repository:{full_name:repository}, head_repository:{full_name:repository},
  head_branch:"dev", head_sha:sha, path:".github/workflows/ci.yml", run_number:4, run_attempt:1, status:"queued", conclusion:null,
};
const fallback = {
  ...push, id:12, event:"workflow_dispatch", run_number:5, display_title:"Contour hosted fallback",
  actor:{id:42}, triggering_actor:{id:42},
};

function fixture({selected = push, dispatched = fallback, known = [push], head = sha} = {}) {
  const calls = [];
  return {calls, github:{
    async json(method, route, options) {
      calls.push({method, route, options});
      if (route.includes("/runs?")) {
        const event = new URL(route, "https://example.test").searchParams.get("event");
        const matching = known.filter((run) => run.event === event);
        return {total_count:matching.length, workflow_runs:matching};
      }
      if (route.endsWith("/runs/11")) return selected;
      if (route.endsWith("/runs/12")) return dispatched;
      if (route.endsWith("/branches/dev")) return {commit:{sha:head}};
      if (route.endsWith("/dispatches")) return {workflow_run_id:12};
      assert.fail("Unexpected route: " + route);
    },
    async request(method, route) {
      calls.push({method, route});
      return new Response(null, {status:202});
    },
  }};
}

test("the scheduler dispatch is verified before only the exact push is cancelled", async () => {
  const {calls, github} = fixture();
  assert.deepEqual(await replacePush(github, expected), {push_run_id:11, fallback_run_id:12});
  const writes = calls.filter(({method}) => method === "POST");
  assert.deepEqual(writes, [
    {method:"POST", route:"/repos/owner/project/actions/workflows/ci.yml/dispatches",
      options:{body:{ref:"dev", inputs:{runner:"github", "runner-profile":"linux-x64"}}}},
    {method:"POST", route:"/repos/owner/project/actions/runs/11/cancel"},
  ]);
  assert.ok(calls.findIndex(({route}) => route.endsWith("/runs/12")) < calls.indexOf(writes[1]));
});

test("a repeated request reuses the confirmed fallback and preserves a completed push", async () => {
  const cancelled = {...push, status:"completed", conclusion:"cancelled", run_started_at:"2026-01-01T00:00:00Z"};
  const {calls, github} = fixture({selected:cancelled, known:[cancelled, fallback]});
  assert.deepEqual(await replacePush(github, expected), {push_run_id:11, fallback_run_id:12});
  assert.deepEqual(calls.filter(({method}) => method === "POST"), []);
});

test("a different head, actor or run prevents cancellation of the selected push", async () => {
  for (const state of [
    {selected:{...push, head_sha:"b".repeat(40)}},
    {head:"b".repeat(40)},
    {dispatched:{...fallback, triggering_actor:{id:13}}},
    {dispatched:{...fallback, head_sha:"b".repeat(40)}},
    {dispatched:null},
  ]) {
    const {calls, github} = fixture(state);
    await assert.rejects(() => replacePush(github, expected));
    assert.ok(!calls.some(({route}) => route.endsWith("/runs/11/cancel")));
    if (state.dispatched?.head_sha && state.dispatched.head_sha !== sha)
      assert.ok(calls.some(({route}) => route.endsWith("/runs/12/cancel")));
  }
});
