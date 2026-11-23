import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main as promote } from "../actions/promote/run.mjs";
import { comparisonPageSize, selectPromotion } from "../lib/promotion.mjs";
import { client, qualify, recheck } from "../lib/qualification.mjs";

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
    const parameters = new URL(route, "https://api.invalid").searchParams;
    const head = parameters.get("head_sha");
    const listed = (runs[head] ?? []).filter(run => !parameters.has("event") || run.event === parameters.get("event"));
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

async function listen(t, handler) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("the promotion action retries an interrupted API page and chooses the qualified commit", async (t) => {
  const ahead = Array.from({length: 251}, (_, n) => sha(n + 1));
  const github = api({ahead, runs: {[ahead.at(-1)]: [run(ahead.at(-1))]}});
  const requests = [];
  let pageAttempts = 0;
  const url = await listen(t, async (request, response) => {
    requests.push(request.method);
    if (request.url.endsWith("&page=3") && ++pageAttempts === 1) {
      request.socket.destroy();
      return;
    }
    response.end(JSON.stringify(await github.json(request.method, request.url)));
  });
  const directory = mkdtempSync(path.join(tmpdir(), "promotion-api-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const output = path.join(directory, "output");
  await promote({
    "INPUT_GITHUB-TOKEN": "fixture",
    GITHUB_API_URL: url,
    GITHUB_REPOSITORY: repository,
    GITHUB_OUTPUT: output,
  });
  assert.equal(readFileSync(output, "utf8"), `state=ready\nsha=${ahead.at(-1)}\n`);
  assert.equal(pageAttempts, 2);
  assert.ok(requests.every((method) => method === "GET"));
});

test("promotion reads retry interrupted bodies and report the final cause when recovery fails", async (t) => {
  let partial = 0, gateway = 0, broken = 0;
  const url = await listen(t, (request, response) => {
    if (request.url === "/partial") {
      if (++partial === 1) {
        response.writeHead(200, {"Content-Length": 100});
        response.write('{"truncated":', () => request.socket.destroy());
      } else response.end('{"complete":true}');
    } else if (request.url === "/gateway") {
      response.writeHead(++gateway < 3 ? 502 : 504).end();
    } else {
      broken++;
      request.socket.destroy();
    }
  });
  const github = client("fixture", url, {retryReads: true});
  assert.deepEqual(await github.json("GET", "/partial"), {complete: true});
  assert.equal(partial, 2);
  await assert.rejects(github.json("GET", "/gateway"), /after 3 attempts \(HTTP 504\)/);
  assert.equal(gateway, 3);
  await assert.rejects(github.json("GET", "/broken"), /after 3 attempts \(UND_ERR_SOCKET\)/);
  assert.equal(broken, 3);
});

test("promotion does not retry writes, malformed JSON, authorization failures or rate limits", async (t) => {
  const calls = [];
  const url = await listen(t, (request, response) => {
    calls.push([request.method, request.url]);
    if (request.method === "POST") {
      request.socket.destroy();
    } else if (request.url === "/denied") {
      response.writeHead(403).end();
    } else if (request.url === "/limited") {
      response.writeHead(503, {"Retry-After": "30"}).end();
    } else response.end("{");
  });
  const github = client("fixture", url, {retryReads: true});
  await assert.rejects(github.json("POST", "/write"), /transport did not complete/);
  await assert.rejects(github.json("GET", "/denied"), /HTTP 403/);
  await assert.rejects(github.json("GET", "/limited"), /HTTP 503/);
  await assert.rejects(github.json("GET", "/malformed"), /malformed JSON/);
  assert.deepEqual(calls, [["POST", "/write"], ["GET", "/denied"], ["GET", "/limited"], ["GET", "/malformed"]]);
});

test("promotion does not start a retry after the request budget runs out", async (t) => {
  let attempts = 0;
  const url = await listen(t, () => { attempts++; });
  const github = client("fixture", url, {retryReads: true});
  await assert.rejects(github.json("GET", "/slow", {timeout: 120}), /after 1 attempt \(request timeout\)/);
  assert.equal(attempts, 1);
});

test("a timed-out first attempt leaves enough of the read budget to recover", async (t) => {
  let attempts = 0;
  const url = await listen(t, (request, response) => {
    if (++attempts === 2) response.end('{"recovered":true}');
  });
  const github = client("fixture", url, {retryReads: true});
  assert.deepEqual(await github.json("GET", "/temporary-delay", {timeout: 2000}), {recovered: true});
  assert.equal(attempts, 2);
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

test("branch eligibility matches the configured App actor and exact scoped run name", async () => {
  const commit = sha(1);
  const cancelled = run(commit, {conclusion: "cancelled"});
  const actor = {id: 27};
  const hosted = run(commit, {event: "workflow_dispatch", display_title: "Contour hosted fallback", actor, triggering_actor: actor});
  const fallbackActorId = "27";
  const expected = {repository, workflowPath, sha: commit, branch: "dev"};
  const github = (push, dispatch) => api({ahead: [commit], runs: {[commit]: [...push, ...dispatch]}});
  const selectWith = (client) => selectPromotion(client, {repository, workflowPath, fallbackActorId});
  const valid = github([cancelled], [hosted]);
  assert.equal((await selectWith(valid)).run_id, hosted.id);
  assert.equal((await selectWith(github([], [hosted]))).run_id, hosted.id);
  assert.equal(valid.calls.filter(route => route.includes("/actions/workflows/")).length, 1);
  assert.equal((await select(valid)).state, "unchecked");
  const proof = await qualify(valid, expected, {waitMinutes: 0, fallbackActorId});
  assert.equal(proof.event, "workflow_dispatch");
  assert.equal((await recheck(valid, proof, {fallbackActorId})).run_id, hosted.id);

  for (const dispatch of [
    {...hosted, display_title: "Manual run"},
    {...hosted, actor: {id: 34}},
    {...hosted, triggering_actor: {id: 34}},
    {...hosted, triggering_actor: null},
    {...hosted, run_number: cancelled.run_number - 1 || 1},
    {...hosted, conclusion: "failure"},
  ]) assert.equal((await selectWith(github([cancelled], [dispatch]))).state, "unchecked");
  for (const conclusion of ["failure", "timed_out"]) {
    const laterFailure = run(commit, {conclusion});
    assert.equal((await selectWith(github([laterFailure], [hosted]))).state, "unchecked");
  }
  for (const other of [
    {...hosted, head_sha: sha(3)},
    {...hosted, head_branch: "main"},
    {...hosted, path: ".github/workflows/other.yml"},
    {...hosted, head_repository: {full_name: "foreign/repository"}},
  ]) await assert.rejects(selectWith(github([cancelled], [other])), /foreign identity/);

  const superseded = github([cancelled], [hosted, {...hosted, run_attempt: 2, conclusion: "failure"}]);
  await assert.rejects(recheck(superseded, proof, {fallbackActorId}), /newest check/);
  const manuallyRerun = github([cancelled], [hosted, {...hosted, run_attempt: 2, triggering_actor: {id: 34}}]);
  assert.equal((await selectWith(manuallyRerun)).state, "unchecked");
  const laterManual = run(commit, {event: "workflow_dispatch", display_title: "Contour hosted fallback",
    actor: {id: 34}, triggering_actor: {id: 34}});
  assert.equal((await selectWith(github([cancelled], [hosted, laterManual]))).run_id, hosted.id);
  const laterPush = run(commit);
  assert.equal((await selectWith(github([cancelled, laterPush], [hosted]))).run_id, laterPush.id);
  await assert.rejects(recheck(github([cancelled, laterPush], [hosted]), proof, {fallbackActorId}), /replaced/);
});
