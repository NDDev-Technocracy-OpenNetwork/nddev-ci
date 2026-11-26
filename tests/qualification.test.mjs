import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { client, downloadArtifact, qualify, receipt, recheck, selectArtifacts, transferArtifacts } from "../lib/qualification.mjs";

const where = {repository: "fixture/project", sha: "a".repeat(40), workflowPath: ".github/workflows/ci.yml", branch: "dev", event: "push"};
const started = new Date(Date.now() - 10000).toISOString();
const run = (fields = {}) => ({id: 7, run_number: 12, run_attempt: 1, head_sha: where.sha, head_branch: "dev", event: "push",
  path: where.workflowPath, status: "completed", conclusion: "success", run_started_at: started,
  repository: {full_name: where.repository}, head_repository: {full_name: where.repository}, ...fields});
const qualified = {schema_version: 1, ...where, run_id: 7, run_number: 12, run_attempt: 1, run_started_at: started};
const inventory = (runs = [run()]) => ({total_count: runs.length, workflow_runs: runs});
const artifact = (fields = {}) => ({id: 9, name: "build", size_in_bytes: 3, digest: `sha256:${"b".repeat(64)}`,
  created_at: new Date(Date.parse(started) + 1000).toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), expired: false,
  workflow_run: {id: 7, head_sha: where.sha, head_branch: "dev"}, ...fields});
const artifacts = (...rows) => ({total_count: rows.length, artifacts: rows});

test("real same-tree parent and child commits require their own result", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qualification-git-"));
  const git = (...args) => execFileSync("git", args, {cwd: root, encoding: "utf8", env: {...process.env,
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test"}}).trim();
  try {
    git("init", "-q"); writeFileSync(path.join(root, "source"), "same bytes\n"); git("add", "source"); git("commit", "-qm", "feat: add fixture");
    const parent = git("rev-parse", "HEAD"); git("commit", "--allow-empty", "-qm", "chore: advance identity"); const child = git("rev-parse", "HEAD");
    assert.notEqual(parent, child);
    assert.equal(git("rev-parse", `${parent}^{tree}`), git("rev-parse", `${child}^{tree}`));
    const api = {json: async () => inventory([run({head_sha: parent})])};
    await assert.rejects(qualify(api, {...where, sha: child}, {waitMinutes: 0}), /No qualification/);
    api.json = async () => inventory([run({head_sha: child})]);
    assert.equal((await qualify(api, {...where, sha: child}, {waitMinutes: 0})).sha, child);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("pending qualification has a finite budget and malformed inventories cannot borrow green", async () => {
  let clock = 0, requests = 0;
  const api = {json: async () => { requests++; return inventory([run({status: "queued", conclusion: null, run_started_at: null})]); }};
  await assert.rejects(qualify(api, where, {waitMinutes: 1, now: () => clock, sleep: async (ms) => {clock += ms;}}), /No qualification/);
  assert.equal(clock, 60000); assert.equal(requests, 3);
  for (const listed of [{total_count: 101, workflow_runs: [run()]}, {total_count: 2, workflow_runs: [run()]},
    inventory([run(), run({id: 8, run_number: 13, repository: null})]),
    inventory([run(), run({id: 8, run_number: 13, head_repository: {full_name: "foreign/project"}})]),
    inventory([run({status: "unknown", conclusion: null})])])
    await assert.rejects(qualify({json: async () => listed}, where, {waitMinutes: 0}));
  await assert.rejects(qualify({json: async () => inventory()}, where, {waitMinutes: 121}));
  await assert.rejects(qualify({json: async () => inventory()}, {...where, event: "pull_request"}));
});

test("a run not listed yet waits within the budget, and stays missing without one", async () => {
  let clock = 0, listings = 0;
  const api = {json: async () => ++listings < 3 ? inventory([]) : inventory()};
  const result = await qualify(api, where, {waitMinutes: 15, now: () => clock, sleep: async (ms) => {clock += ms;}});
  assert.equal(result.run_id, 7);
  assert.equal(listings, 3);
  await assert.rejects(qualify({json: async () => inventory([])}, where, {waitMinutes: 0}), /No dev push check/);
  clock = 0;
  await assert.rejects(qualify({json: async () => inventory([])}, where, {waitMinutes: 1, now: () => clock,
    sleep: async (ms) => {clock += ms;}}), /No dev push check/);
  assert.equal(clock, 60000);
});

test("a new attempt invalidates an existing qualification receipt", async () => {
  assert.equal(receipt(qualified).run_id, 7);
  assert.throws(() => receipt({...qualified, run_attempt: 0}));
  await recheck({json: async () => inventory()}, qualified);
  await assert.rejects(recheck({json: async () => inventory([run({run_attempt: 2})])}, qualified), /newer run or attempt/);
});

test("branch fallback qualifies only the configured App and its exact passed full job", async () => {
  const actor = {id: 7001};
  const dispatch = run({id: 8, run_number: 13, event: "workflow_dispatch",
    display_title: "Contour hosted fallback", actor, triggering_actor: actor});
  const failedPush = run({conclusion: "cancelled"});
  const full = {id: 9, name: "check / full check", run_id: 8, run_attempt: 1, head_sha: where.sha,
    status: "completed", conclusion: "success"};
  const configured = {waitMinutes: 0, fallbackActorId: "7001"};
  const api = (candidate = dispatch, job = full, push = failedPush) => ({
    json: async (_, route) => route.includes("/jobs?") ? {total_count: 1, jobs: [job]}
      : route.includes("event=workflow_dispatch") ? inventory([candidate]) : inventory([push]),
  });
  const result = await qualify(api(), where, configured);
  assert.equal(result.event, "workflow_dispatch");
  assert.equal(result.run_id, 8);
  await recheck(api(), result, configured);

  await assert.rejects(qualify(api(), where, {waitMinutes: 0}), /No qualification/);
  for (const change of [{display_title: "Normal dispatch"}, {actor: {id: 7002}}, {triggering_actor: {id: 7002}}])
    await assert.rejects(qualify(api({...dispatch, ...change}), where, configured), /No qualification/);
  for (const change of [{name: "check / short check"}, {run_attempt: 2}, {head_sha: "b".repeat(40)}, {conclusion: "skipped"}])
    await assert.rejects(qualify(api(dispatch, {...full, ...change}), where, configured), /exact hosted fallback full job/);
  await assert.rejects(recheck(api({...dispatch, triggering_actor: {id: 7002}}), result, configured), /No qualification/);
  const newerPush = run({id: 12, run_number: 14});
  await assert.rejects(recheck(api(dispatch, full, newerPush), result, configured), /newer run or attempt/);
});

test("artifacts require exact ownership, attempt freshness, expiration and mandatory digests", () => {
  assert.equal(selectArtifacts(artifacts(artifact()), qualified, ["build"])[0].id, 9);
  const old = artifact({id: 8, created_at: new Date(Date.parse(started) - 1000).toISOString()});
  assert.equal(selectArtifacts(artifacts(old, artifact()), qualified, ["build"])[0].id, 9);
  for (const fields of [{digest: undefined}, {size_in_bytes: 0}, {expired: true}, {expires_at: "2000-01-01T00:00:00Z"},
    {created_at: "2000-01-01T00:00:00Z"}, {workflow_run: {id: 8, head_sha: where.sha, head_branch: "dev"}},
    {workflow_run: {id: 7, head_sha: "c".repeat(40), head_branch: "dev"}}])
    assert.throws(() => selectArtifacts(artifacts(artifact(fields)), qualified, ["build"]));
  assert.throws(() => selectArtifacts(artifacts(artifact(), artifact({id: 10})), qualified, ["build"]));
  assert.throws(() => selectArtifacts({total_count: 2, artifacts: [artifact()]}, qualified, ["build"]));
});

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {server, url: `http://127.0.0.1:${server.address().port}`};
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
// Runs the actual release entrypoint as the runner does and returns its exit code and output.
async function runRelease(env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../actions/release/run.mjs", import.meta.url))], {
    stdio: ["ignore", "pipe", "pipe"], timeout: 10000, env: {...process.env, ...env}});
  let output = "";
  child.stdout.on("data", (bytes) => {output += bytes;}); child.stderr.on("data", (bytes) => {output += bytes;});
  const [code] = await once(child, "close");
  return {code, output};
}
async function refuseRelease(env, reason) {
  const {code, output} = await runRelease(env);
  assert.equal(code, 1, output); assert.match(output, reason);
  assert.equal(existsSync(env.GITHUB_OUTPUT), false, "a refused release emits no outputs");
}

test("mutable status reads revalidate a cached success after a newer failure", async () => {
  let state = "success", id = 1, cached;
  const expected = {repository: where.repository, sha: where.sha, context: "readiness", creator: 77, maximumStatuses: 1000};
  const { requireStatus } = await import("../lib/commit-status.mjs");
  const api = await listen((req, res) => {
    const status = () => ({id, state, context: expected.context, creator: {id: 77},
      url: `${api.url}/repos/${where.repository}/statuses/${where.sha}`});
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST") {
      let body = ""; req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { state = JSON.parse(body).state; id++; res.end(JSON.stringify(status())); });
    } else {
      if (!cached || req.headers["cache-control"] === "no-cache") cached = [status()];
      res.setHeader("Cache-Control", "private, max-age=60");
      res.end(JSON.stringify(cached));
    }
  });
  try {
    const github = client("read-token-fixture", api.url);
    assert.equal((await requireStatus(github, expected)).state, "ready");
    await github.json("POST", `/repos/${where.repository}/statuses/${where.sha}`, {body: {state: "failure"}});
    await assert.rejects(requireStatus(github, expected), /status is failure/);
  } finally { await close(api.server); }
});

test("real redirect and failure servers receive credentials only at the declared API origin", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qualification-http-"));
  const bytes = Buffer.from("zip bytes fixture"), headers = [], locations = [];
  let fail = false;
  const storage = await listen((req, res) => {
    headers.push(req.headers.authorization); locations.push(req.url);
    res.writeHead(fail ? 500 : 200); res.end(fail ? "failure" : bytes);
  });
  const api = await listen((req, res) => {
    assert.equal(req.headers.authorization, "Bearer read-token-fixture");
    res.writeHead(302, {location: `${storage.url}/archive?signed=private-transport-value`}); res.end();
  });
  const pinned = artifact({size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`});
  try {
    const github = client("read-token-fixture", api.url);
    await downloadArtifact(github, where.repository, pinned, path.join(root, "archive"));
    assert.deepEqual(readFileSync(path.join(root, "archive")), bytes);
    assert.deepEqual(headers, [undefined]);
    await assert.rejects(github.request("GET", `${storage.url}/steal`), /cannot leave/);
    fail = true;
    await assert.rejects(downloadArtifact(github, where.repository, pinned, path.join(root, "failure")), (error) => {
      assert.doesNotMatch(error.message, /read-token-fixture|signed=|private-transport-value/); return true;
    });
    assert.deepEqual(headers, [undefined, undefined]);
    assert.ok(locations.every((location) => location.startsWith("/archive?")));
  } finally { await close(api.server); await close(storage.server); rmSync(root, {recursive: true, force: true}); }
});

test("promotion transfers a checked artifact after interrupted API and signed storage reads", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "promotion-transfer-"));
  const zip = path.join(root, "fixture.zip");
  execFileSync("python3", ["-I", "-c", "import sys,stat,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); i=zipfile.ZipInfo('fixture.txt'); i.external_attr=(stat.S_IFREG|0o644)<<16; z.writestr(i,b'checked data'); z.close()",
    zip]);
  const bytes = readFileSync(zip);
  const metadata = artifact({size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`});
  const attempts = {listing: 0, redirect: 0, storage: 0};
  const storage = await listen((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    if (++attempts.storage === 1) {
      res.writeHead(200, {"Content-Length": bytes.length});
      res.write(bytes.subarray(0, 8), () => req.socket.destroy());
    } else res.end(bytes);
  });
  const api = await listen((req, res) => {
    if (req.url.includes("/actions/workflows/")) res.end(JSON.stringify(inventory()));
    else if (req.url.includes("/artifacts?")) {
      if (++attempts.listing === 1) req.socket.destroy();
      else res.end(JSON.stringify(artifacts(metadata)));
    } else {
      if (++attempts.redirect === 1) req.socket.destroy();
      else res.writeHead(302, {location: storage.url + "/archive"}).end();
    }
  });
  try {
    const github = client("read-token-fixture", api.url, {retryReads: true});
    const checked = path.join(root, "checked");
    await transferArtifacts(github, qualified, "build", checked);
    assert.equal(readFileSync(path.join(checked, "fixture.txt"), "utf8"), "checked data");
    assert.deepEqual(attempts, {listing: 2, redirect: 2, storage: 2});
  } finally { await close(api.server); await close(storage.server); rmSync(root, {recursive: true, force: true}); }
});

test("actual ZIP bytes transfer atomically; tampering, unsafe members and newer attempts leave no result", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qualification-transfer-"));
  const zip = path.join(root, "fixture.zip");
  const pack = (name) => {
    execFileSync("python3", ["-I", "-c", "import sys,stat,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); i=zipfile.ZipInfo(sys.argv[2]); i.external_attr=(stat.S_IFREG|0o755)<<16; z.writestr(i,b'checked native binary'); z.close()", zip, name]);
    return readFileSync(zip);
  };
  let bytes = pack("program.bin"), attempt = 1, mutate = false;
  const metadata = () => artifact({size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`});
  const api = await listen((req, res) => {
    if (req.url.includes("/workflows/")) {
      const current = attempt; if (mutate) attempt++;
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(inventory([run({run_attempt: current})])));
    } else if (req.url.endsWith("/artifacts?per_page=100")) {
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(artifacts(metadata())));
    } else { res.end(bytes); }
  });
  const github = client("read-token-fixture", api.url);
  try {
    const destination = path.join(root, "result");
    const result = await transferArtifacts(github, qualified, "build", destination);
    assert.equal(readFileSync(path.join(destination, "program.bin"), "utf8"), "checked native binary");
    assert.equal(result.files[0].sha256, createHash("sha256").update("checked native binary").digest("hex"));
    bytes = pack("../escape");
    await assert.rejects(transferArtifacts(github, qualified, "build", path.join(root, "unsafe")), /extraction refused/);
    assert.equal(existsSync(path.join(root, "unsafe")), false);
    bytes = pack("program.bin"); mutate = true;
    await assert.rejects(transferArtifacts(github, qualified, "build", path.join(root, "newer")), /newer run or attempt/);
    assert.equal(existsSync(path.join(root, "newer")), false);
    assert.ok(readdirSync(root).every((name) => !name.startsWith(".checked-artifacts-")));
    await assert.rejects(downloadArtifact(github, where.repository, {...metadata(), digest: `sha256:${"0".repeat(64)}`}, path.join(root, "tampered")), /differ/);
  } finally { await close(api.server); rmSync(root, {recursive: true, force: true}); }
});

test("the actual release entrypoint never prints unexpected error details", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "release-error-boundary-"));
  const privatePath = path.join(root, "private-credential-fixture");
  writeFileSync(privatePath, "a regular file cannot hold the release workspace");
  let reads = 0;
  const api = await listen((req, res) => {
    if (req.method !== "GET" || !req.url.includes("/workflows/ci.yml/runs?")) { res.writeHead(405); res.end(); return; }
    reads++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(inventory()));
  });
  try {
    const {code, output} = await runRelease({
      GITHUB_REPOSITORY: where.repository, GITHUB_SHA: where.sha, GITHUB_REF: "refs/heads/main", RUNNER_TEMP: privatePath,
      GITHUB_API_URL: api.url, GITHUB_SERVER_URL: "https://github.com", "INPUT_API-URL": api.url,
      "INPUT_GITHUB-TOKEN": "opaque-credential-fixture", "INPUT_WAIT-MINUTES": "0", INPUT_ARTIFACTS: "",
      "INPUT_CHECK-WORKFLOW": "ci.yml"});
    assert.equal(code, 1); assert.equal(reads, 1);
    assert.match(output, /Release failed before completion\./);
    assert.doesNotMatch(output, /private-credential-fixture|opaque-credential-fixture/);
  } finally { await close(api.server); rmSync(root, {recursive: true, force: true}); }
});

test("the release entrypoint publishes qualified files and checksums after transient read failures and reconciles a rerun", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "release-publish-"));
  const zip = path.join(root, "build.zip"), binary = Buffer.from("checked native binary");
  execFileSync("python3", ["-I", "-c", "import sys,stat,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); i=zipfile.ZipInfo('program.bin'); i.external_attr=(stat.S_IFREG|0o755)<<16; z.writestr(i,b'checked native binary'); z.close()", zip]);
  const bytes = readFileSync(zip), uploads = new Map();
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const tags = [{ref: "refs/tags/v1.0.0", object: {type: "commit", sha: "b".repeat(40)}}];
  let release = null, mutations = 0, checks = 0;
  // Each read fails once the way a GitHub outage does: a gateway error or a dropped connection.
  const faults = new Map([["/workflows/ci.yml/", 502], ["/matching-refs/tags/v", "drop"], ["/artifacts/9/zip", "drop"],
    ["/releases/tags/v1.0.1", 503]]);
  const api = await listen(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks), route = req.url;
    const json = (value, status = 200) => { res.writeHead(status, {"content-type": "application/json"}); res.end(JSON.stringify(value)); };
    const fault = req.method === "GET" && [...faults.keys()].find((part) => route.includes(part));
    if (fault) {
      const failure = faults.get(fault); faults.delete(fault);
      if (failure === "drop") req.socket.destroy(); else res.writeHead(failure).end();
      return;
    }
    if (req.method !== "GET") mutations++;
    if (route.includes("/workflows/")) {
      checks++;
      const name = route.split("/workflows/")[1].split("/")[0];
      const value = inventory();
      value.workflow_runs = value.workflow_runs.map((run) => ({...run, id: run.id + ({"ci.yml": 0, "portable.yml": 100, "artifact.yml": 200}[name]),
        path: `.github/workflows/${name}`}));
      json(value);
    }
    else if (route.endsWith("/artifacts?per_page=100")) json(artifacts(artifact({size_in_bytes: bytes.length, digest: `sha256:${digest(bytes)}`})));
    else if (route.endsWith("/artifacts/9/zip")) res.end(bytes);
    else if (route.endsWith("/matching-refs/tags/v")) json(tags);
    else if (route.endsWith("/git/ref/tags/v1.0.1")) json(tags[1] ?? {}, tags[1] ? 200 : 404);
    else if (route.endsWith("/git/refs")) {
      assert.deepEqual(JSON.parse(body), {ref: "refs/tags/v1.0.1", sha: where.sha});
      tags.push({ref: "refs/tags/v1.0.1", object: {type: "commit", sha: where.sha}}); json(tags[1]);
    } else if (route.endsWith("/releases/tags/v1.0.1")) json(release ?? {}, release ? 200 : 404);
    else if (route.includes("/releases?per_page=100&page=")) json(release ? [release] : []);
    else if (route.endsWith("/releases?per_page=100")) json([]);
    else if (route.endsWith("/releases/generate-notes")) json({body: "Fixture changes"});
    else if (route.endsWith("/releases") && req.method === "POST") {
      release = {...JSON.parse(body), id: 11, assets: [], upload_url: `${api.url}/upload{?name}`, html_url: "https://github.com/fixture/project/releases/tag/v1.0.1"};
      assert.equal(release.draft, true); assert.equal(release.name, "project 1.0.1"); json(release);
    } else if (route.startsWith("/upload?")) {
      const name = new URL(route, api.url).searchParams.get("name");
      uploads.set(name, body); const asset = {name, size: body.length, digest: `sha256:${digest(body)}`};
      release.assets.push(asset); json(asset);
    } else if (route.endsWith("/releases/11") && req.method === "PATCH") {
      Object.assign(release, JSON.parse(body), {published_at: new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, "Z")}); json(release);
    } else { res.writeHead(404); res.end(); }
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const temp = mkdtempSync(path.join(root, "attempt-"));
      const before = mutations, {code, output} = await runRelease({
        GITHUB_REPOSITORY: where.repository, GITHUB_SHA: where.sha, GITHUB_REF: "refs/heads/main", RUNNER_TEMP: temp,
        GITHUB_API_URL: api.url, GITHUB_SERVER_URL: "https://github.com", "INPUT_API-URL": api.url,
        "INPUT_GITHUB-TOKEN": "opaque-credential-fixture", "INPUT_REQUIRED-WORKFLOWS": "portable.yml\nartifact.yml", "INPUT_WAIT-MINUTES": "0", INPUT_ARTIFACTS: "build",
        GITHUB_OUTPUT: path.join(temp, "outputs"), GITHUB_STEP_SUMMARY: path.join(temp, "summary")});
      assert.equal(code, 0, output); assert.equal(release.draft, false);
      assert.match(readFileSync(path.join(temp, "outputs"), "utf8"), /version=1\.0\.1\ntag=v1\.0\.1/);
      if (attempt) assert.equal(mutations, before, "a published exact release needs no second mutation");
    }
    assert.equal(faults.size, 0, "every transient read failure was met and recovered");
    assert.equal(mutations, 6, "tag, notes, draft, two uploads and publication each ran once");
    assert.deepEqual([...uploads.keys()], ["program.bin", "SHA256SUMS"]);
    assert.deepEqual(uploads.get("program.bin"), binary);
    assert.equal(uploads.get("SHA256SUMS").toString(), `${digest(binary)}  program.bin\n`);
    assert.ok(checks >= 8, "each attempt rechecks qualification around transfer and publication");
  } finally { await close(api.server); rmSync(root, {recursive: true, force: true}); }
});

test("a permanent API error fails the release at once with its cause", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "release-permanent-"));
  let requests = 0;
  const api = await listen((req, res) => { requests++; res.writeHead(404).end(); });
  try {
    await refuseRelease({
      GITHUB_REPOSITORY: where.repository, GITHUB_SHA: where.sha, GITHUB_REF: "refs/heads/main", RUNNER_TEMP: root,
      GITHUB_API_URL: api.url, "INPUT_API-URL": api.url, "INPUT_GITHUB-TOKEN": "opaque-credential-fixture",
      "INPUT_WAIT-MINUTES": "0", GITHUB_OUTPUT: path.join(root, "outputs")}, /HTTP 404/);
    assert.equal(requests, 1);
  } finally { await close(api.server); rmSync(root, {recursive: true, force: true}); }
});

test("a connect timeout repeats a read and never repeats a write", async () => {
  const api = await listen((req, res) => { res.setHeader("content-type", "application/json"); res.end('{"answered":true}'); });
  const fetchOnce = globalThis.fetch;
  let calls = 0;
  // undici reports a connect timeout as a TypeError whose cause carries the code.
  globalThis.fetch = async (url, options) => {
    if (++calls === 1) throw new TypeError("fetch failed", {cause: Object.assign(new Error("Connect Timeout Error"), {code: "UND_ERR_CONNECT_TIMEOUT"})});
    return fetchOnce(url, options);
  };
  try {
    const github = client("fixture", api.url, {retryReads: true});
    assert.deepEqual(await github.json("GET", "/read"), {answered: true});
    assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(github.json("POST", "/write", {body: {}}), /transport did not complete \(UND_ERR_CONNECT_TIMEOUT\)/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = fetchOnce; await close(api.server); }
});

test("read-only actions recover from transient GitHub read failures", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "read-actions-"));
  const zip = path.join(root, "build.zip");
  execFileSync("python3", ["-I", "-c", "import sys,stat,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); i=zipfile.ZipInfo('program.bin'); i.external_attr=(stat.S_IFREG|0o644)<<16; z.writestr(i,b'checked bytes'); z.close()", zip]);
  const bytes = readFileSync(zip);
  const metadata = artifact({size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`});
  const status = {id: 11, context: "source/ready", creator: {id: 7}, state: "success",
    url: `https://api.github.com/repos/${where.repository}/statuses/${where.sha}`};
  const failed = new Set();
  const api = await listen((req, res) => {
    assert.equal(req.method, "GET");
    if (!failed.has(req.url)) { failed.add(req.url); if (failed.size % 2) res.writeHead(502).end(); else req.socket.destroy(); return; }
    res.setHeader("content-type", "application/json");
    if (req.url.includes("/actions/workflows/")) res.end(JSON.stringify(inventory()));
    else if (req.url.includes("/statuses?")) res.end(JSON.stringify(req.url.endsWith("page=1") ? [status] : []));
    else if (req.url.endsWith("/artifacts?per_page=100")) res.end(JSON.stringify(artifacts(metadata)));
    else if (req.url.endsWith("/artifacts/9/zip")) res.end(bytes);
    else res.writeHead(404).end();
  });
  try {
    const env = {GITHUB_API_URL: api.url, GITHUB_REPOSITORY: where.repository, GITHUB_SHA: where.sha, RUNNER_TEMP: root,
      "INPUT_GITHUB-TOKEN": "fixture-read-token", "INPUT_WAIT-MINUTES": "0"};
    const {main: qualifyAction} = await import("../actions/qualify/run.mjs");
    assert.equal((await qualifyAction({...env, GITHUB_OUTPUT: path.join(root, "qualify")})).run_id, 7);
    assert.equal(failed.size, 1);
    failed.clear();
    const {main: statusAction} = await import("../actions/require-status/run.mjs");
    assert.equal((await statusAction({...env, GITHUB_OUTPUT: path.join(root, "status"), INPUT_SHA: where.sha,
      INPUT_CONTEXT: status.context, "INPUT_CREATOR-ID": "7", "INPUT_MAXIMUM-STATUSES": "150"})).state, "ready");
    assert.equal(failed.size, 1);
    failed.clear();
    const {main: checkedAction} = await import("../actions/checked-artifacts/run.mjs");
    await checkedAction({...env, GITHUB_OUTPUT: path.join(root, "checked"), INPUT_RECEIPT: JSON.stringify(qualified),
      INPUT_ARTIFACTS: "build", INPUT_DIRECTORY: "checked-files"});
    assert.equal(readFileSync(path.join(root, "checked-files", "program.bin"), "utf8"), "checked bytes");
    assert.equal(failed.size, 3, "the recheck, artifact listing and download each failed once");
  } finally { await close(api.server); rmSync(root, {recursive: true, force: true}); }
});

test("product promotion and publication refuse false checked metadata before any write", async () => {
  const { main: choose } = await import("../actions/promote/run.mjs");
  for (const variant of ["valid", "wrong-source", "platform-mismatch", "missing", "consumed", "malformed"]) {
    const root = mkdtempSync(path.join(tmpdir(), "product-release-"));
    const version = "2.6.0";
    const linux = {schema_version: 1, source_commit: variant === "wrong-source" ? "c".repeat(40) : where.sha, version};
    const mac = {...linux, version: variant === "platform-mismatch" ? "2.6.1" : version};
    const entries = {"linux.json": variant === "malformed" ? "{" : JSON.stringify(linux)};
    if (variant !== "missing") entries["mac.json"] = JSON.stringify(mac);
    const archive = path.join(root, "build.zip");
    execFileSync("python3", ["-I", "-c", "import sys,stat,zipfile,json; z=zipfile.ZipFile(sys.argv[1],'w');\nfor n,v in json.loads(sys.argv[2]).items():\n i=zipfile.ZipInfo(n); i.external_attr=(stat.S_IFREG|0o644)<<16; z.writestr(i,v)\nz.close()", archive, JSON.stringify(entries)]);
    const bytes = readFileSync(archive), digest = (data) => createHash("sha256").update(data).digest("hex");
    const tags = [{ref: "refs/tags/v2.4.2", object: {type: "commit", sha: "b".repeat(40)}}];
    if (variant === "consumed") tags.push({ref: `refs/tags/v${version}`, object: {type: "commit", sha: "c".repeat(40)}});
    let release = null, writes = 0;
    const api = await listen(async (req, res) => {
      const parts = []; for await (const chunk of req) parts.push(chunk);
      const body = Buffer.concat(parts), route = req.url;
      const json = (value, status = 200) => {res.writeHead(status, {"content-type": "application/json"});res.end(JSON.stringify(value));};
      if (req.method !== "GET") writes++;
      if (route.endsWith("/branches/dev")) json({name: "dev", commit: {sha: where.sha}});
      else if (route.endsWith("/branches/main")) json({name: "main", commit: {sha: "b".repeat(40)}});
      else if (route.includes("/compare/")) json({ahead_by: 1, behind_by: 0, total_commits: 1,
        base_commit: {sha: "b".repeat(40)}, merge_base_commit: {sha: "b".repeat(40)}, commits: [{sha: where.sha}]});
      else if (route.includes("/workflows/")) json(inventory());
      else if (route.endsWith("/artifacts?per_page=100")) json(artifacts(artifact({size_in_bytes: bytes.length, digest: `sha256:${digest(bytes)}`})));
      else if (route.endsWith("/artifacts/9/zip")) res.end(bytes);
      else if (route.endsWith("/matching-refs/tags/v")) json(tags);
      else if (route.endsWith(`/git/ref/tags/v${version}`)) {const known = tags.find((tag) => tag.ref === `refs/tags/v${version}`);json(known ?? {}, known ? 200 : 404);}
      else if (route.endsWith("/git/refs")) {tags.push({ref: `refs/tags/v${version}`, object: {type: "commit", sha: where.sha}});json(tags.at(-1));}
      else if (route.endsWith(`/releases/tags/v${version}`)) json(release ?? {}, release ? 200 : 404);
      else if (route.endsWith("/releases?per_page=100")) json([]);
      else if (route.endsWith("/releases/generate-notes")) json({body: "Fixture changes"});
      else if (route.endsWith("/releases") && req.method === "POST") {
        release = {...JSON.parse(body), id: 11, assets: [], upload_url: `${api.url}/upload{?name}`, html_url: "https://github.com/fixture/project/releases/tag/v2.6.0"};
        assert.equal(release.tag_name, "v2.6.0");json(release);
      } else if (route.startsWith("/upload?")) {
        const asset = {name: new URL(route, api.url).searchParams.get("name"), size: body.length, digest: `sha256:${digest(body)}`};release.assets.push(asset);json(asset);
      } else if (route.endsWith("/releases/11") && req.method === "PATCH") {Object.assign(release, JSON.parse(body));json(release);}
      else {res.writeHead(404);res.end();}
    });
    try {
      const temp = mkdtempSync(path.join(root, "promote-"));
      const env = {...process.env, GITHUB_REPOSITORY: where.repository, GITHUB_API_URL: api.url,
        RUNNER_TEMP: temp, GITHUB_OUTPUT: path.join(temp, "output"),
        "INPUT_GITHUB-TOKEN": "opaque-credential-fixture", INPUT_ARTIFACTS: "build", "INPUT_RELEASE-METADATA": "linux.json\nmac.json"};
      if (variant === "valid") {
        const chosen = await choose(env); assert.equal(chosen.version, version);assert.equal(chosen.state, "ready");
      } else if (variant === "consumed") {
        // The source still declares the newest release: promotion waits for its next version.
        const chosen = await choose(env); assert.equal(chosen.state, "unversioned");
        assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "state=unversioned\nsha=\n");
      } else {
        await assert.rejects(choose(env), /metadata|version/i, variant);
        assert.equal(existsSync(env.GITHUB_OUTPUT), false, "a refused choice emits no ready commit");
      }
      assert.equal(writes, 0, "the promotion choice performs no mutation");
      assert.ok(readdirSync(temp).every((name) => !name.startsWith("nddev-ci-promotion-")));
      for (let attempt = 0; attempt < (variant === "valid" ? 2 : 1); attempt++) {
        const work = mkdtempSync(path.join(root, "release-"));
        const before = writes, {code, output} = await runRelease({...env,
          RUNNER_TEMP: work, GITHUB_SHA: where.sha, GITHUB_REF: "refs/heads/main", "INPUT_API-URL": api.url,
          "INPUT_WAIT-MINUTES": "0", GITHUB_OUTPUT: path.join(work, "outputs"), GITHUB_STEP_SUMMARY: path.join(work, "summary")});
        assert.equal(code, variant === "valid" ? 0 : 1, `${variant}: ${output}`);
        if (variant !== "valid" || attempt) assert.equal(writes, before, "refusal/rerun creates no tag or release");
        if (variant === "valid") assert.match(readFileSync(path.join(work, "outputs"), "utf8"), /version=2\.6\.0/);
      }
    } finally {await close(api.server);rmSync(root, {recursive: true, force: true});}
  }
});

test("required workflow names are bounded and cannot repeat or leave the workflow directory", async () => {
  const {qualificationWorkflows} = await import("../lib/qualification.mjs");
  assert.deepEqual(qualificationWorkflows(".github/workflows/ci.yml", " portable.yml\r\nartifact.yml\n"),
    [".github/workflows/ci.yml", ".github/workflows/portable.yml", ".github/workflows/artifact.yml"]);
  for (const names of ["ci.yml", "portable.yml\nportable.yml", "../foreign.yml", "bad.yml?x", "a b.yml",
    Array.from({length: 9}, (_, i) => `w${i}.yml`).join("\n")])
    assert.throws(() => qualificationWorkflows(".github/workflows/ci.yml", names));
});

for (const variant of ["failed", "replaced", "foreign", "duplicate"])
  test(`a ${variant} required workflow prevents promotion readiness and the publisher's first mutation`, async () => {
    const {main: choose} = await import("../actions/promote/run.mjs");
    const root = mkdtempSync(path.join(tmpdir(), "required-workflow-"));
    let writes = 0, secondaryReads = 0;
    const api = await listen(async (req, res) => {
      for await (const chunk of req) {void chunk;}
      if (req.method !== "GET") writes++;
      if (req.method === "GET" && (req.url.includes("/git/ref/tags/") || req.url.includes("/releases/tags/"))) {
        res.writeHead(404);res.end();return;
      }
      let value = inventory();
      if (req.url.endsWith("/branches/dev")) value = {name: "dev", commit: {sha: where.sha}};
      else if (req.url.endsWith("/branches/main")) value = {name: "main", commit: {sha: "b".repeat(40)}};
      else if (req.url.includes("/compare/")) value = {ahead_by: 1, behind_by: 0, total_commits: 1,
        base_commit: {sha: "b".repeat(40)}, merge_base_commit: {sha: "b".repeat(40)}, commits: [{sha: where.sha}]};
      else if (req.url.endsWith("/matching-refs/tags/v")) value = [];
      else if (req.url.includes("/workflows/portable.yml/")) {
        secondaryReads++;
        value.workflow_runs = value.workflow_runs.map((run) => ({...run,
          id: variant === "duplicate" ? run.id : run.id + 100,
          path: variant === "foreign" ? ".github/workflows/foreign.yml" : ".github/workflows/portable.yml",
          run_attempt: variant === "replaced" && secondaryReads > 1 ? 2 : 1,
          conclusion: variant === "failed" || (variant === "replaced" && secondaryReads > 1) ? "failure" : "success"}));
      }
      res.writeHead(200, {"content-type": "application/json"});res.end(JSON.stringify(value));
    });
    try {
      const env = {...process.env, GITHUB_REPOSITORY: where.repository, GITHUB_SHA: where.sha, GITHUB_REF: "refs/heads/main", RUNNER_TEMP: root,
        GITHUB_API_URL: api.url, "INPUT_API-URL": api.url, "INPUT_GITHUB-TOKEN": "opaque-credential-fixture",
        "INPUT_WAIT-MINUTES": "0", "INPUT_REQUIRED-WORKFLOWS": "portable.yml", INPUT_ARTIFACTS: "", "INPUT_RELEASE-METADATA": "",
        GITHUB_OUTPUT: path.join(root, "promotion-output"), GITHUB_STEP_SUMMARY: path.join(root, "summary")};
      if (variant === "failed") assert.equal((await choose(env)).state, "unchecked");
      else {await assert.rejects(choose(env));assert.equal(existsSync(env.GITHUB_OUTPUT), false);}
      assert.equal(writes, 0);
      assert.ok(secondaryReads > 0, "the negative case must reach required workflow qualification");
      if (variant === "replaced") assert.ok(secondaryReads > 1, "the newer attempt must be rechecked");
      secondaryReads = 0;
      await refuseRelease({...env, GITHUB_OUTPUT: path.join(root, "outputs")}, /No qualification|same run identity/);
      assert.equal(writes, 0, "required workflows must stop the first publication mutation");
    } finally {await close(api.server);rmSync(root, {recursive: true, force: true});}
  });

test("a failed workflow ends a shared qualification wait while another workflow is pending", async () => {
  const {qualifyWorkflows} = await import("../lib/qualification.mjs");
  const github = {async json(_method, route) {
    const value = inventory();
    value.workflow_runs = value.workflow_runs.map((run) => route.includes("portable.yml")
      ? {...run, id: run.id + 100, path: ".github/workflows/portable.yml", conclusion: "failure"}
      : {...run, status: "in_progress", conclusion: null});
    return value;
  }};
  await assert.rejects(qualifyWorkflows(github, where, "portable.yml", {waitMinutes: 30,
    sleep: async () => assert.fail("a known failed workflow must not leave a pending waiter")}), /portable.yml/);
});

test("actions/qualify supports required-workflows and retries transient GitHub HTTP 500 reads", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qualify-multi-"));
  let failedOnce = false;
  const seen = [];
  const api = await listen((req, res) => {
    seen.push(req.url);
    if (!failedOnce && req.url.includes("/workflows/ci.yml/")) {
      failedOnce = true;
      res.writeHead(500).end();
      return;
    }
    const name = req.url.split("/workflows/")[1].split("/")[0];
    const offset = {"recipe-smoke.yml": 0, "ci.yml": 100, "source-version-smoke.yml": 200}[name] ?? 0;
    const value = inventory([run({id: 7 + offset, path: `.github/workflows/${name}`})]);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  });
  try {
    const {main: qualifyAction} = await import("../actions/qualify/run.mjs");
    const out = path.join(root, "qualify-out");
    const result = await qualifyAction({
      GITHUB_API_URL: api.url,
      GITHUB_REPOSITORY: where.repository,
      GITHUB_SHA: where.sha,
      GITHUB_OUTPUT: out,
      "INPUT_GITHUB-TOKEN": "fixture-read-token",
      "INPUT_CHECK-WORKFLOW": "recipe-smoke.yml",
      "INPUT_REQUIRED-WORKFLOWS": "ci.yml\nsource-version-smoke.yml",
      "INPUT_WAIT-MINUTES": "0",
    });
    assert.equal(result.workflowPath, ".github/workflows/recipe-smoke.yml");
    assert.equal(result.run_id, 7);
    assert.equal(failedOnce, true);
    assert.ok(seen.some((u) => u.includes("/workflows/source-version-smoke.yml/")));
  } finally {
    await close(api.server);
    rmSync(root, {recursive: true, force: true});
  }
});

test("draft release asset uploads retry 5xx and transport drops with partial starter cleanup and fail fast on 4xx", async () => {
  const {uploadDraftAsset} = await import("../actions/release/run.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "release-upload-retry-"));
  const filePath = path.join(root, "tool.bin");
  const payload = Buffer.from("verified release payload");
  writeFileSync(filePath, payload);
  const sha = createHash("sha256").update(payload).digest("hex");
  const file = {name: "tool.bin", path: filePath, size: payload.length, sha256: sha};

  for (const mode of ["starter-502", "completed-on-drop", "exhausted-503", "permanent-422"]) {
    let uploadAttempts = 0;
    let deletes = [];
    let releaseReads = 0;
    let assets = [];
    const api = await listen(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const send = (status, value, headers = {}) => {
        res.writeHead(status, {"content-type": "application/json", ...headers});
        res.end(value === undefined ? undefined : JSON.stringify(value));
      };
      if (req.method === "GET" && req.url === `/repos/${where.repository}/releases/11`) {
        releaseReads++;
        return send(200, {id: 11, draft: true, assets});
      }
      if (req.method === "DELETE" && req.url.startsWith(`/repos/${where.repository}/releases/assets/`)) {
        const assetId = Number(req.url.split("/").pop());
        deletes.push(assetId);
        assets = assets.filter((item) => item.id !== assetId);
        res.writeHead(204).end();
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/upload?")) {
        uploadAttempts++;
        if (mode === "starter-502" && uploadAttempts === 1) {
          assets.push({id: 501, name: "tool.bin", state: "starter", size: 0, digest: null});
          return send(502, {message: "bad gateway"});
        }
        if (mode === "completed-on-drop" && uploadAttempts === 1) {
          assets.push({id: 502, name: "tool.bin", state: "uploaded", size: body.length, digest: `sha256:${sha}`});
          req.socket.destroy();
          return;
        }
        if (mode === "exhausted-503") {
          assets.push({id: 600 + uploadAttempts, name: "tool.bin", state: "starter", size: 0, digest: null});
          return send(503, {message: "service unavailable"});
        }
        if (mode === "permanent-422") return send(422, {message: "already_exists"});
        assert.deepEqual(body, payload);
        const uploaded = {id: 700, name: "tool.bin", state: "uploaded", size: body.length, digest: `sha256:${sha}`};
        assets.push(uploaded);
        return send(201, uploaded);
      }
      res.writeHead(404).end();
    });
    try {
      const github = client("fixture", api.url, {retryReads: true});
      const release = {id: 11, draft: true, upload_url: `${api.url}/upload{?name}`, assets: []};
      const call = () => uploadDraftAsset(github, {
        repository: where.repository, release, file, backoffMs: () => 0,
      });
      if (mode === "starter-502") {
        const result = await call();
        assert.equal(result.id, 700);
        assert.equal(uploadAttempts, 2);
        assert.deepEqual(deletes, [501]);
        assert.equal(releaseReads, 1);
      } else if (mode === "completed-on-drop") {
        const result = await call();
        assert.equal(result.id, 502);
        assert.equal(uploadAttempts, 1);
        assert.deepEqual(deletes, []);
        assert.equal(releaseReads, 1);
      } else if (mode === "exhausted-503") {
        await assert.rejects(call(), (error) => {
          assert.match(error.message, /failed after 3 attempts \(HTTP 503\)/);
          assert.equal(error.upstreamReason, "github-5xx");
          return true;
        });
        assert.equal(uploadAttempts, 3);
        assert.deepEqual(deletes, [601, 602, 603]);
      } else {
        await assert.rejects(call(), (error) => {
          assert.match(error.message, /HTTP 422/);
          assert.equal(error.upstreamReason, undefined);
          return true;
        });
        assert.equal(uploadAttempts, 1);
        assert.equal(releaseReads, 0);
      }
    } finally {
      await close(api.server);
    }
  }
  rmSync(root, {recursive: true, force: true});
});
