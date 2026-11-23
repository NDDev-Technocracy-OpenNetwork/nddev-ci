import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { main } from "../actions/merge-on-green/run.mjs";
import { selectMerge } from "../lib/merge-on-green.mjs";

const repository = "fixture/project";
const sha = "a".repeat(40);
const pull = (fields = {}) => ({number: 7, state: "open", draft: false, title: "chore: update", labels: [{name: "merge-on-green"}],
  head: {sha, ref: "renovate/x", repo: {full_name: repository}}, base: {ref: "dev", repo: {full_name: repository}}, ...fields});
const requiredChecks = "check / short check\ncheck / merge-stops / merge stops";
let nextId = 0;
const run = (name, conclusion = "success", status = "completed", fields = {}) => ({id: ++nextId, name, status, conclusion,
  head_sha: sha, app: {id: 15368, slug: "github-actions"}, ...fields});

const requiredRuns = () => requiredChecks.split("\n").map((name) => run(name));

function api({pulls = [pull()], runs = requiredRuns(), status = {total_count: 0, state: "pending", sha}}) {
  return {json: async (method, route) => {
    if (route.includes("/pulls")) return pulls;
    if (route.includes("/check-runs")) {
      const page = Number(new URL(route, "https://api.github.com").searchParams.get("page"));
      return {total_count: runs.length, check_runs: runs.slice((page - 1) * 100, page * 100)};
    }
    if (route.endsWith("/status")) return status;
    throw new Error(route);
  }};
}
const select = (github, extra = {}) => selectMerge(github, {repository, sha, requiredChecks, self: "merge on green", ...extra});

test("a labelled pull request whose checks all passed is ready", async () => {
  const result = await select(api({runs: [run("check / short check"), run("check / merge-stops / merge stops"), run("macos", "skipped"), run("merge on green", null, "in_progress")]}));
  assert.equal(result.state, "ready");
  assert.equal(result.number, 7);
  assert.equal(result.base, "dev");
});

test("a running or failed check holds the merge", async () => {
  assert.equal((await select(api({runs: [...requiredRuns(), run("b", null, "queued")]}))).state, "pending");
  assert.equal((await select(api({runs: [...requiredRuns(), run("b", "failure")]}))).state, "failed");
  assert.equal((await select(api({runs: [...requiredRuns(), run("a", "cancelled")]}))).state, "failed");
});

test("only the merge job itself is not enough", async () => {
  assert.equal((await select(api({runs: [run("merge on green", null, "in_progress")]}))).state, "pending");
});

test("no label, a draft, a fork or a moved head selects nothing", async () => {
  for (const fields of [{labels: []}, {draft: true}, {head: {sha, ref: "x", repo: {full_name: "other/fork"}}},
    {head: {sha: "b".repeat(40), ref: "x", repo: {full_name: repository}}}, {state: "closed"}])
    assert.equal((await select(api({pulls: [pull(fields)]}))).state, "none");
});

test("the requested pull number and integration branch bind an outside merger to one candidate", async () => {
  const main = {ref: "main", repo: {full_name: repository}};
  const github = api({pulls: [pull(), pull({number: 8, base: main}), pull({number: 9, base: main})]});
  const result = await select(github, {pullNumber: 9, base: "main"});
  assert.equal(result.state, "ready");
  assert.equal(result.number, 9);
  assert.equal(result.base, "main");
  assert.equal((await select(github, {pullNumber: 9, base: "dev"})).state, "none");
  assert.equal((await select(github, {pullNumber: 10, base: "main"})).state, "none");
  await assert.rejects(select(github, {pullNumber: 0, base: "main"}), /number or base branch/);
});

test("a failing commit status holds the merge", async () => {
  assert.equal((await select(api({status: {total_count: 1, state: "failure", sha}}))).state, "failed");
  assert.equal((await select(api({status: {total_count: 1, state: "success", sha}}))).state, "ready");
});

test("malformed input is refused", async () => {
  await assert.rejects(selectMerge(api({}), {repository: "bad", sha}));
  await assert.rejects(selectMerge(api({}), {repository, sha: "short"}));
});


test("mandatory native skips cannot authorize a merge through the real action", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "merge-on-green-"));
  const runs = [run("check / short check", "skipped"), run("check / merge-stops / merge stops")];
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({method: req.method, url: req.url, authorization: req.headers.authorization});
    const url = new URL(req.url, "http://127.0.0.1");
    const value = url.pathname.endsWith("/pulls") ? [pull()]
      : url.pathname.endsWith("/check-runs") ? {total_count: runs.length, check_runs: runs}
      : url.pathname.endsWith("/status") ? {total_count: 0, state: "pending", sha} : null;
    res.writeHead(value ? 200 : 404, {"Content-Type": "application/json"}); res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const output = path.join(root, "output");
  try {
    const result = await main({GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_REPOSITORY: repository,
      GITHUB_OUTPUT: output, INPUT_SHA: sha, "INPUT_GITHUB-TOKEN": "fixture-read-token", "INPUT_REQUIRED-CHECKS": requiredChecks});
    assert.notEqual(result.state, "ready", "mandatory native success must be proved");
    assert.doesNotMatch(readFileSync(output, "utf8"), /state=ready/);
    assert.ok(requests.every((request) => request.method === "GET" && request.authorization === "Bearer fixture-read-token"));
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    rmSync(root, {recursive: true, force: true});
  }
});


test("every mandatory native and merge-stop result needs genuine success", async () => {
  for (const index of [0, 1]) {
    for (const conclusion of ["failure", "skipped", "neutral", "cancelled", "timed_out", "action_required", null]) {
      const runs = requiredRuns(); runs[index].conclusion = conclusion;
      assert.equal((await select(api({runs: [...runs, run("independent")]}))).state, "failed");
    }
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
      const runs = requiredRuns(); Object.assign(runs[index], {status, conclusion: null});
      assert.equal((await select(api({runs}))).state, "pending");
    }
    const runs = requiredRuns(); runs.splice(index, 1);
    assert.equal((await select(api({runs: [...runs, run("independent")]}))).state, "pending");
  }
  assert.equal((await select(api({runs: []}))).state, "pending");
  assert.equal((await select(api({runs: [...requiredRuns(), run("optional", "neutral")]}))).state, "ready");
});

test("newest named attempts win regardless of response order", async () => {
  const native = requiredChecks.split("\n")[0];
  const old = run(native, "success", "completed", {id: 1});
  const stop = run(requiredChecks.split("\n")[1], "success", "completed", {id: 2});
  for (const conclusion of ["skipped", "neutral", "failure"]) {
    const newer = run(native, conclusion, "completed", {id: 3});
    for (const runs of [[old, stop, newer], [newer, stop, old]])
      assert.equal((await select(api({runs}))).state, "failed");
  }
  assert.equal((await select(api({runs: [old, stop, run(native, null, "queued", {id: 3})]}))).state, "pending");
  assert.equal((await select(api({runs: [{...old, conclusion: "failure"}, stop, run(native, "success", "completed", {id: 3})]}))).state, "ready");
});

test("foreign integrations and commits cannot supply mandatory proof", async () => {
  for (const app of [{id: 9, slug: "other-app"}, {id: 9, slug: "github-actions"}, {id: 15368, slug: "other-app"}]) {
    const runs = requiredRuns(); runs[0].app = app;
    assert.equal((await select(api({runs}))).state, "failed");
  }
  const runs = requiredRuns(); runs[0].head_sha = "b".repeat(40);
  await assert.rejects(select(api({runs})), /foreign source identity/);
  await assert.rejects(select(api({runs: [...requiredRuns(), run("other", "success", "completed", {head_sha: "b".repeat(40)})]})), /foreign source identity/);
});

test("only complete stable check inventories can qualify the newest results", async () => {
  const rows = [...requiredRuns(), ...Array.from({length: 99}, (_, i) => run(`optional/${i}`, "skipped"))];
  assert.equal((await select(api({runs: rows}))).state, "ready");
  const original = api({runs: rows});
  for (const value of [null, {}, {total_count: 1, check_runs: []}, {total_count: 1001, check_runs: []},
    {total_count: 2, check_runs: [rows[0], rows[0]]}, {total_count: 101, check_runs: rows},
    {total_count: 1, check_runs: [{...rows[0], id: 0}]}, {total_count: 1, check_runs: [{...rows[0], app: null}]},
    {total_count: 1, check_runs: [{...rows[0], name: "bad\nname"}]}]) {
    await assert.rejects(select({json: (method, route) => route.includes("/check-runs") ? value : original.json(method, route)}));
  }
  let reads = 0;
  await assert.rejects(select({json: (method, route) => route.includes("/check-runs")
    ? {total_count: ++reads === 1 ? 101 : 102, check_runs: reads === 1 ? rows.slice(0, 100) : rows.slice(100)}
    : original.json(method, route)}), /changed/);
  reads = 0;
  await assert.rejects(select({json: (method, route) => route.includes("/check-runs")
    ? {total_count: 101, check_runs: ++reads === 1 ? rows.slice(0, 100) : [rows[0]]}
    : original.json(method, route)}), /repeated/);
});

test("mandatory names cannot be absent, repeated or excluded as the merge job", async () => {
  for (const requiredChecks of [undefined, "", " \n", "native\nnative", "merge on green", "bad\0name", "a".repeat(256)])
    await assert.rejects(select(api({}), {requiredChecks}), /Mandatory check names/);
  await assert.rejects(select(api({}), {requiredChecks: Array.from({length: 101}, (_, i) => `check/${i}`).join("\n")}), /Mandatory check names/);
  const requiredChecks = "custom/native\ncustom/stops";
  assert.equal((await select(api({runs: [run("custom/native"), run("custom/stops"), run("optional", "skipped")]}), {requiredChecks})).state, "ready");
});

test("malformed status identity and unsafe base cannot authorize a merge", async () => {
  for (const status of [null, {}, {total_count: -1, state: "success", sha}, {total_count: 1, state: "success", sha: "b".repeat(40)},
    {total_count: 0, state: "unknown", sha}])
    await assert.rejects(select(api({status})), /commit statuses/);
  for (const state of ["failure", "error", "pending"])
    assert.equal((await select(api({status: {total_count: 1, state, sha}}))).state, state === "pending" ? "pending" : "failed");
  await assert.rejects(select(api({pulls: [pull({base: {ref: "unsafe..base", repo: {full_name: repository}}})]})), /base branch/);
  assert.equal((await select(api({pulls: [pull({base: {ref: "dev", repo: {full_name: "other/project"}}})]}))).state, "none");
});

test("a failed head followed by unrelated-label skips stays unqualified over HTTP", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "merge-transition-"));
  const native = run("check / short check", "failure"), stop = run("check / merge-stops / merge stops");
  let all = [native, stop], latest = all;
  const queries = [];
  const server = createServer((req, res) => {
    assert.equal(req.method, "GET"); assert.equal(req.headers["cache-control"], "no-cache");
    const url = new URL(req.url, "http://127.0.0.1"); queries.push(url);
    const rows = url.searchParams.get("filter") === "all" ? all : latest;
    const value = url.pathname.endsWith("/pulls") ? [pull()]
      : url.pathname.endsWith("/check-runs") ? {total_count: rows.length, check_runs: rows}
      : url.pathname.endsWith("/status") ? {total_count: 0, state: "pending", sha} : null;
    res.writeHead(value ? 200 : 404, {"Content-Type": "application/json"}); res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const output = path.join(root, "output");
  const env = {GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_REPOSITORY: repository,
    GITHUB_OUTPUT: output, INPUT_SHA: sha, "INPUT_GITHUB-TOKEN": "fixture-read-token", "INPUT_REQUIRED-CHECKS": requiredChecks};
  try {
    assert.equal((await main(env)).state, "failed");
    latest = [run(native.name, "skipped"), run(stop.name, "skipped"), run("independent")]; all.push(...latest);
    assert.equal((await main(env)).state, "failed");
    assert.doesNotMatch(readFileSync(output, "utf8"), /state=ready/);
    latest = [...requiredRuns(), run("optional", "skipped")]; all.push(...latest);
    assert.equal((await main(env)).state, "ready");
    assert.match(readFileSync(output, "utf8"), /state=ready\nnumber=7\nbase=dev\nhead=renovate\/x\n/);
    assert.ok(queries.filter((url) => url.pathname.endsWith("/check-runs")).every((url) => url.searchParams.get("filter") === "all"));
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    rmSync(root, {recursive: true, force: true});
  }
});

test("the service entry point returns a read-only receipt for the pinned pull request and base", async () => {
  const runs = requiredRuns();
  const mainPull = pull({base: {ref: "main", repo: {full_name: repository}}});
  const server = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer fixture-read-token");
    const route = new URL(req.url, "http://127.0.0.1").pathname;
    const value = route.endsWith("/pulls") ? [mainPull]
      : route.endsWith("/check-runs") ? {total_count: runs.length, check_runs: runs}
      : route.endsWith("/status") ? {total_count: 0, state: "pending", sha} : null;
    res.writeHead(value ? 200 : 404, {"Content-Type": "application/json"}); res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const file = fileURLToPath(new URL("../tools/qualify-merge.mjs", import.meta.url));
    const invoke = async (base) => {
      const { stdout } = await promisify(execFile)(process.execPath, [file, repository, "7", sha, base, ...requiredChecks.split("\n")], {
        env: {...process.env, GH_TOKEN: "fixture-read-token", GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`},
      });
      return JSON.parse(stdout);
    };
    assert.deepEqual(await invoke("main"), {repository, sha, state: "ready", number: 7, base: "main", head: "renovate/x"});
    assert.deepEqual(await invoke("dev"), {repository, sha, state: "none"});
    runs[0].conclusion = "failure";
    assert.equal((await invoke("main")).state, "failed");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
