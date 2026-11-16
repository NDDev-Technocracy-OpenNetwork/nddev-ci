import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reconcile } from "../tools/repository-rules.mjs";

const desired = JSON.parse(readFileSync(new URL("../.github/rulesets/dev.json", import.meta.url), "utf8"));
const repository = "fixture/library";
const row = (id, name = desired.name) => ({id, name, source_type: "Repository", source: repository});
function api(initial = []) {
  let rows = initial, written, lose = false;
  const calls = [];
  return {calls, setLose: () => {lose = true;}, json: async (method, route, options) => {
    calls.push({method, route});
    if (method === "GET" && route.includes("?")) return structuredClone(rows);
    if (method === "GET") return {...rows.find((r) => route.endsWith(`/${r.id}`)), ...(written ?? {})};
    written = options.body;
    if (method === "POST") rows = [...rows, row(9)];
    if (lose) { lose = false; throw Error("lost write reply"); }
    return {};
  }};
}

test("plan stays read-only; apply creates once, preserves foreign rules and repeats without mutation", async () => {
  const github = api([row(7, "Unrelated rule")]);
  assert.deepEqual(await reconcile(github, repository, desired, "plan"), {state: "create", id: null});
  assert.ok(github.calls.every((c) => c.method === "GET"));
  assert.deepEqual(await reconcile(github, repository, desired, "apply"), {state: "applied", id: 9});
  assert.deepEqual(await reconcile(github, repository, desired, "apply"), {state: "current", id: 9});
  assert.equal(github.calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(github.calls.filter((c) => c.method === "PUT" || c.method === "DELETE").length, 0);
});
test("a lost write reply is accepted only from a complete observed matching rule", async () => {
  const github = api(); github.setLose();
  assert.equal((await reconcile(github, repository, desired, "apply")).state, "applied");
  assert.equal(github.calls.filter((c) => c.method === "POST").length, 1);
  const missing = {json: async (method) => {if (method !== "GET") throw Error("lost write reply"); return [];}};
  await assert.rejects(reconcile(missing, repository, desired, "apply"), /lost write reply/);
});
test("duplicate, truncated and foreign inventories refuse before mutation", async () => {
  for (const rows of [[row(1), row(2)], [row(1), row(1)], Array.from({length: 100}, (_, i) => row(i + 1, `other${i}`)),
    [{...row(1), source: "foreign/library"}], [{...row(1), source_type: "Organization"}], null]) {
    const calls = [];
    await assert.rejects(reconcile({json: async (method) => {calls.push(method); return rows;}}, repository, desired, "apply"));
    assert.deepEqual(calls, ["GET"]);
  }
});
test("a drifted managed rule updates only its own ID and still verifies the full definition", async () => {
  const github = api([row(7)]);
  assert.deepEqual(await reconcile(github, repository, desired, "plan"), {state: "update", id: 7});
  assert.deepEqual(await reconcile(github, repository, desired, "apply"), {state: "applied", id: 7});
  assert.ok(github.calls.some((c) => c.method === "PUT" && c.route.endsWith("/7")));
  await assert.rejects(reconcile({json: async (method, route) => method === "GET" ? route.includes("?") ? [row(7)] : row(7) : {}},
    repository, desired, "apply"), /did not reach/);
});
test("bypass actors, an inactive rule or an unbound check is refused before any read", async () => {
  const never = {json: () => {throw Error("unexpected read");}};
  for (const change of [{bypass_actors: [{actor_type: "DeployKey", bypass_mode: "always"}]}, {enforcement: "disabled"},
    {rules: [{type: "required_status_checks", parameters: {required_status_checks: [{context: "unbound"}]}}]}])
    await assert.rejects(reconcile(never, repository, {...desired, ...change}, "apply"), /bypass-free/);
  await assert.rejects(reconcile(never, "../library", desired, "apply"), /exact repository/);
});
