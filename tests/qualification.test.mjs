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

test("a new attempt invalidates an existing qualification receipt", async () => {
  assert.equal(receipt(qualified).run_id, 7);
  assert.throws(() => receipt({...qualified, run_attempt: 0}));
  await recheck({json: async () => inventory()}, qualified);
  await assert.rejects(recheck({json: async () => inventory([run({run_attempt: 2})])}, qualified), /newer run or attempt/);
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
    const child = spawn(process.execPath, [fileURLToPath(new URL("../actions/release/run.mjs", import.meta.url))], {
      stdio: ["ignore", "pipe", "pipe"], timeout: 10000, env: {...process.env,
        GITHUB_REPOSITORY: where.repository, GITHUB_SHA: where.sha, GITHUB_REF: "refs/heads/main", RUNNER_TEMP: privatePath,
        GITHUB_API_URL: api.url, GITHUB_SERVER_URL: "https://github.com", "INPUT_API-URL": api.url,
        "INPUT_GITHUB-TOKEN": "opaque-credential-fixture", "INPUT_WAIT-MINUTES": "0", INPUT_ARTIFACTS: "",
        "INPUT_CHECK-WORKFLOW": "ci.yml", "INPUT_CHECK-BRANCH": "dev", "INPUT_RELEASE-BRANCH": "main", "INPUT_TAG-PREFIX": "v"},
    });
    let output = "";
    child.stdout.on("data", (bytes) => {output += bytes;}); child.stderr.on("data", (bytes) => {output += bytes;});
    const [code] = await once(child, "close");
    assert.equal(code, 1); assert.equal(reads, 1);
    assert.match(output, /Release failed before completion\./);
    assert.doesNotMatch(output, /private-credential-fixture|opaque-credential-fixture/);
  } finally { await close(api.server); rmSync(root, {recursive: true, force: true}); }
});
