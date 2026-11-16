import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireStatus } from "../lib/commit-status.mjs";
import { main } from "../actions/require-status/run.mjs";

const expected = {repository: "fixture/project", sha: "a".repeat(40), context: "source/ready", creator: 7, maximumStatuses: 150};
const status = (fields = {}) => ({id: 11, context: expected.context, creator: {id: 7}, state: "success", ...fields});
const page = (statuses = [status()], fields = {}) => ({sha: expected.sha, repository: {full_name: expected.repository},
  state: "failure", total_count: statuses.length, statuses, ...fields});
const api = (value) => ({json: async () => value});

test("only the exact trusted context qualifies, independent of unrelated failures", async () => {
  const result = await requireStatus(api(page([status({id: 12, context: "unrelated", state: "failure"}), status()])), expected);
  assert.deepEqual(result, {state: "ready", sha: expected.sha, statusId: 11});
  for (const state of ["pending", "failure", "error", "unknown"])
    await assert.rejects(requireStatus(api(page([status({state})])), expected));
  for (const fields of [{creator: {id: 8}}, {creator: null}, {creator: {id: "7"}}, {context: "other"}])
    await assert.rejects(requireStatus(api(page([status(fields)])), expected));
  await assert.rejects(requireStatus(api(page([])), expected), /missing/);
});

test("complete bounded pagination cannot borrow a partial, duplicate or changed inventory", async () => {
  const rows = Array.from({length: 149}, (_, i) => status({id: 100 + i, context: `other/${i}`}));
  rows.push(status());
  const calls = [];
  const paged = {json: async (method, route) => {
    calls.push([method, route]);
    return page(rows.slice((calls.length - 1) * 100, calls.length * 100), {total_count: 150});
  }};
  assert.equal((await requireStatus(paged, expected)).statusId, 11);
  assert.deepEqual(calls, [1, 2].map((n) => ["GET", `/repos/fixture/project/commits/${expected.sha}/status?per_page=100&page=${n}`]));
  for (const value of [page(undefined, {total_count: 2}), page(undefined, {total_count: 151}),
    page(undefined, {total_count: "1"}), page(undefined, {total_count: -1}), page(undefined, {statuses: null}),
    page(undefined, {sha: "b".repeat(40)}), page(undefined, {repository: {full_name: "foreign/project"}}),
    page([status(), status({id: 12})]), page([status(), status({context: "other"})]),
    page([null]), page([status({id: 0})])])
    await assert.rejects(requireStatus(api(value), expected));
  let requests = 0;
  await assert.rejects(requireStatus({json: async () => page(rows.slice(requests++ * 100, requests * 100),
    {total_count: requests === 1 ? 150 : 149})}, expected), /changed/);
  requests = 0;
  await assert.rejects(requireStatus({json: async () => page(rows.slice(requests++ * 100, requests * 100).slice(0, 1),
    {total_count: 150})}, expected), /incomplete/);
  assert.equal(requests, 1);
});

test("invalid identities and bounds fail before an API read", async () => {
  const never = {json: () => { throw Error("unexpected request"); }};
  for (const fields of [{repository: "../project"}, {repository: "fixture/.."}, {repository: "a/b?x"}, {sha: "dev"},
    {sha: "A".repeat(40)}, {context: ""}, {context: "a\nb"}, {context: "a".repeat(256)}, {creator: 0},
    {creator: 1.5}, {maximumStatuses: 0}, {maximumStatuses: Number.MAX_SAFE_INTEGER + 1}])
    await assert.rejects(requireStatus(never, {...expected, ...fields}), /needs an exact/);
});

test("the actual action uses read-only transport and writes a receipt only after qualification", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "commit-status-"));
  let value = page(), requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer fixture-read-token");
    assert.equal(req.url, `/repos/fixture/project/commits/${expected.sha}/status?per_page=100&page=1`);
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const output = path.join(root, "output");
  const env = {GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_REPOSITORY: expected.repository,
    GITHUB_OUTPUT: output, "INPUT_GITHUB-TOKEN": "fixture-read-token", INPUT_CONTEXT: expected.context,
    "INPUT_CREATOR-ID": "7", "INPUT_MAXIMUM-STATUSES": "150", INPUT_SHA: expected.sha};
  try {
    await main(env);
    const receipt = `state=ready\nsha=${expected.sha}\nstatus-id=11\n`;
    assert.equal(readFileSync(output, "utf8"), receipt);
    value = page([status({state: "pending"})]);
    await assert.rejects(main(env), /pending/);
    assert.equal(readFileSync(output, "utf8"), receipt);
    await assert.rejects(main({...env, "INPUT_GITHUB-TOKEN": ""}), /token is required/);
    assert.equal(requests, 2);
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    rmSync(root, {recursive: true, force: true});
  }
});
