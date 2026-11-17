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
        "INPUT_CHECK-WORKFLOW": "ci.yml"},
    });
    let output = "";
    child.stdout.on("data", (bytes) => {output += bytes;}); child.stderr.on("data", (bytes) => {output += bytes;});
    const [code] = await once(child, "close");
    assert.equal(code, 1); assert.equal(reads, 1);
    assert.match(output, /Release failed before completion\./);
    assert.doesNotMatch(output, /private-credential-fixture|opaque-credential-fixture/);
  } finally { await close(api.server); rmSync(root, {recursive: true, force: true}); }
});

test("the release entrypoint publishes qualified files and checksums and reconciles a rerun", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "release-publish-"));
  const zip = path.join(root, "build.zip"), binary = Buffer.from("checked native binary");
  execFileSync("python3", ["-I", "-c", "import sys,stat,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); i=zipfile.ZipInfo('program.bin'); i.external_attr=(stat.S_IFREG|0o755)<<16; z.writestr(i,b'checked native binary'); z.close()", zip]);
  const bytes = readFileSync(zip), uploads = new Map();
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const tags = [{ref: "refs/tags/v1.0.0", object: {type: "commit", sha: "b".repeat(40)}}];
  let release = null, mutations = 0, checks = 0;
  const api = await listen(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks), route = req.url;
    const json = (value, status = 200) => { res.writeHead(status, {"content-type": "application/json"}); res.end(JSON.stringify(value)); };
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
      const child = spawn(process.execPath, [fileURLToPath(new URL("../actions/release/run.mjs", import.meta.url))], {
        stdio: ["ignore", "pipe", "pipe"], timeout: 10000, env: {...process.env,
          GITHUB_REPOSITORY: where.repository, GITHUB_SHA: where.sha, GITHUB_REF: "refs/heads/main", RUNNER_TEMP: temp,
          GITHUB_API_URL: api.url, GITHUB_SERVER_URL: "https://github.com", "INPUT_API-URL": api.url,
          "INPUT_GITHUB-TOKEN": "opaque-credential-fixture", "INPUT_REQUIRED-WORKFLOWS": "portable.yml\nartifact.yml", "INPUT_WAIT-MINUTES": "0", INPUT_ARTIFACTS: "build",
          GITHUB_OUTPUT: path.join(temp, "outputs"), GITHUB_STEP_SUMMARY: path.join(temp, "summary")},
      });
      let output = "";
      child.stdout.on("data", (chunk) => {output += chunk;}); child.stderr.on("data", (chunk) => {output += chunk;});
      const before = mutations, [code] = await once(child, "close");
      assert.equal(code, 0, output); assert.equal(release.draft, false);
      assert.match(readFileSync(path.join(temp, "outputs"), "utf8"), /version=1\.0\.1\ntag=v1\.0\.1/);
      if (attempt) assert.equal(mutations, before, "a published exact release needs no second mutation");
    }
    assert.deepEqual([...uploads.keys()], ["program.bin", "SHA256SUMS"]);
    assert.deepEqual(uploads.get("program.bin"), binary);
    assert.equal(uploads.get("SHA256SUMS").toString(), `${digest(binary)}  program.bin\n`);
    assert.ok(checks >= 8, "each attempt rechecks qualification around transfer and publication");
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
      } else {
        await assert.rejects(choose(env), /metadata|version/i, variant);
        assert.equal(existsSync(env.GITHUB_OUTPUT), false, "a refused choice emits no ready commit");
      }
      assert.equal(writes, 0, "the promotion choice performs no mutation");
      assert.ok(readdirSync(temp).every((name) => !name.startsWith("nddev-ci-promotion-")));
      for (let attempt = 0; attempt < (variant === "valid" ? 2 : 1); attempt++) {
        const work = mkdtempSync(path.join(root, "release-"));
        const child = spawn(process.execPath, [fileURLToPath(new URL("../actions/release/run.mjs", import.meta.url))], {
          stdio: ["ignore", "pipe", "pipe"], timeout: 10000, env: {...env,
            RUNNER_TEMP: work, GITHUB_SHA: where.sha, GITHUB_REF: "refs/heads/main", "INPUT_API-URL": api.url,
            "INPUT_WAIT-MINUTES": "0", GITHUB_OUTPUT: path.join(work, "outputs"), GITHUB_STEP_SUMMARY: path.join(work, "summary")},
        });
        let output = "";child.stdout.on("data", (x) => {output += x;});child.stderr.on("data", (x) => {output += x;});
        const before = writes, [code] = await once(child, "close");
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
      const child = spawn(process.execPath, [fileURLToPath(new URL("../actions/release/run.mjs", import.meta.url))], {
        stdio: ["ignore", "pipe", "pipe"], timeout: 10000, env: {...env, GITHUB_OUTPUT: path.join(root, "outputs")},
      });
      let output = "";child.stdout.on("data", (bytes) => {output += bytes;});child.stderr.on("data", (bytes) => {output += bytes;});
      const [code] = await once(child, "close");
      assert.equal(writes, 0, "required workflows must stop the first publication mutation");
      assert.equal(code, 1, output);assert.match(output, /No qualification|same run identity/);
      assert.equal(existsSync(path.join(root, "outputs")), false);
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
