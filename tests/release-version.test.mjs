import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { main as runRelease } from "../actions/release/run.mjs";
import { ReleaseError, UnversionedError } from "../lib/release.mjs";
import { productVersion, readPrereleaseStage, releaseVersion, resolveRelease } from "../lib/release-version.mjs";

const sha = "a".repeat(40), other = "b".repeat(40);
const record = (version = "1.2.3") => ({schema_version: 1, source_commit: sha, version, platform: "example"});
function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "release-version-"));
  const file = (name, data) => {
    const bytes = Buffer.from(typeof data === "string" ? data : JSON.stringify(data));
    const target = path.join(root, name); writeFileSync(target, bytes);
    return {name, path: target, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
  };
  return Promise.resolve().then(() => run(file)).finally(() => rmSync(root, {recursive: true, force: true}));
}
const tag = (version, target = other) => ({ref: `refs/tags/v${version}`, object: {type: "commit", sha: target}});
const api = (tags) => ({json: async (method) => { assert.equal(method, "GET"); return tags; }});

test("checked platform metadata supplies one exact product version", () => fixture((file) => {
  const files = [file("linux.json", record()), file("mac.json", record())];
  assert.equal(productVersion(files, "linux.json\nmac.json", sha), "1.2.3");
  assert.equal(productVersion([], "", sha), null);
  assert.throws(() => productVersion(files, "linux.json\nLINUX.json", sha), /repeats/);
  assert.throws(() => productVersion(files, "missing.json", sha), /missing/);
  assert.throws(() => productVersion([...files, files[0]], "linux.json", sha), /repeated/);
  assert.throws(() => productVersion(files, "../linux.json", sha));
}));

test("wrong source, malformed versions, missing fields and changed checked bytes fail", () => fixture((file) => {
  for (const data of [null, [], {}, {...record(), schema_version: 2}, {...record(), source_commit: other},
    {...record(), version: "v1.2.3"}, {...record(), version: "01.2.3"}, {...record(), version: ["1.2.3"]},
    "{", " ".repeat(65537)]) {
    const f = file("metadata.json", data);
    assert.throws(() => productVersion([f], f.name, sha));
  }
  const f = file("metadata.json", record());
  writeFileSync(f.path, JSON.stringify({...record(), version: "1.2.4"}));
  assert.throws(() => productVersion([f], f.name, sha), /changed/);
  const invalid = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
  writeFileSync(f.path, invalid);
  const encoded = {...f, size: invalid.length, sha256: createHash("sha256").update(invalid).digest("hex")};
  assert.throws(() => productVersion([encoded], encoded.name, sha), /malformed/);
}));

test("platform disagreement cannot select a product version", () => fixture((file) => {
  const files = [file("linux.json", record()), file("mac.json", record("1.2.4"))];
  assert.throws(() => productVersion(files, "linux.json\nmac.json", sha), /disagree/);
}));

test("a product release uses its checked version and reconciles that same commit", () => fixture(async (file) => {
  const fields = {repository: "owner/project", sha, files: [file("metadata.json", record("1.5.0"))], metadata: "metadata.json"};
  assert.equal(await releaseVersion(api([tag("1.2.3")]), fields), "1.5.0");
  assert.equal(await releaseVersion(api([tag("1.2.3"), tag("1.5.0", sha)]), fields), "1.5.0");
  await assert.rejects(releaseVersion(api([tag("1.2.3"), tag("1.5.0")]), fields), UnversionedError);
  for (const tags of [[tag("1.6.0")], [tag("1.5.0"), tag("1.6.0")], [tag("1.4.0", sha)], [tag("1.5.0", sha), tag("1.5.1", sha)]])
    await assert.rejects(releaseVersion(api(tags), fields), (error) => !(error instanceof UnversionedError));
  await assert.rejects(releaseVersion(api([]), {...fields, explicit: "1.6.0"}), /differs/);
}));

test("annotated targets are bounded and tag-only source releases retain their selection", async () => {
  const fields = {repository: "owner/project", sha};
  assert.equal(await releaseVersion(api([tag("1.2.3")]), fields), "1.2.4");
  assert.equal(await releaseVersion(api([tag("1.2.3", sha)]), fields), "1.2.3");
  const annotated = {json: async (_method, route) => route.includes("matching-refs")
    ? [{ref: "refs/tags/v1.2.3", object: {type: "tag", sha: other}}]
    : {object: {type: "commit", sha}}};
  assert.equal(await releaseVersion(annotated, fields), "1.2.3");
  annotated.json = async (_method, route) => route.includes("matching-refs")
    ? [{ref: "refs/tags/v1.2.3", object: {type: "tag", sha: other}}]
    : {object: {type: "tag", sha: other}};
  await assert.rejects(releaseVersion(annotated, fields), /cyclic/);
  await assert.rejects(releaseVersion(api([tag("1.2.3"), tag("1.2.3")]), fields), /repeats/);
  for (const refs of [null, {}, [{ref: "refs/tags/foreign", object: {type: "commit", sha}}]])
    await assert.rejects(releaseVersion(api(refs), fields));
});

const content = (filePath, text) => ({
  type: "file",
  path: filePath,
  encoding: "base64",
  size: Buffer.byteLength(text),
  content: Buffer.from(text).toString("base64") + "\n",
});

const repoApi = ({tags = [], stage = null, file = ".github/prerelease"}) => {
  const routes = [];
  return {
    routes,
    json: async (method, route, options = {}) => {
      assert.equal(method, "GET");
      routes.push(route);
      if (route.includes("/contents/")) {
        assert.equal(route, `/repos/owner/project/contents/${file.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`);
        if (stage === null) return options.optional ? null : Promise.reject(new ReleaseError("missing"));
        return typeof stage === "string" ? content(file, stage) : stage;
      }
      return tags;
    },
  };
};

test("pre-release stage files are read strictly from the exact commit", async () => {
  const untouched = repoApi({});
  assert.equal(await readPrereleaseStage(untouched, {repository: "owner/project", sha, file: ""}), "");
  assert.equal(untouched.routes.length, 0);
  assert.equal(await readPrereleaseStage(repoApi({stage: null}), {repository: "owner/project", sha, file: ".github/prerelease"}), "");
  assert.equal(await readPrereleaseStage(repoApi({stage: "  \n"}), {repository: "owner/project", sha, file: ".github/prerelease"}), "");
  assert.equal(await readPrereleaseStage(repoApi({stage: {type: "file", path: ".github/prerelease", size: 0, encoding: "none", content: ""}}),
    {repository: "owner/project", sha, file: ".github/prerelease"}), "");
  assert.equal(await readPrereleaseStage(repoApi({stage: "2.0.0-alpha\n"}), {repository: "owner/project", sha, file: ".github/prerelease"}), "2.0.0-alpha");

  for (const badPath of ["../prerelease", "/.github/prerelease", ".github/../prerelease", "./prerelease", "a b"])
    await assert.rejects(readPrereleaseStage(repoApi({}), {repository: "owner/project", sha, file: badPath}), ReleaseError, badPath);
  for (const badPayload of [
    [], {type: "symlink", path: ".github/prerelease", size: 11, encoding: "base64", content: "Mi4wLjAtYWxwaGE="},
    {type: "file", path: "other", size: 11, encoding: "base64", content: "Mi4wLjAtYWxwaGE="},
    {type: "file", path: ".github/prerelease", size: 257, encoding: "base64", content: "YQ=="},
    {type: "file", path: ".github/prerelease", size: 5, encoding: "base64", content: "Mi4wLjAtYWxwaGE="},
    {type: "file", path: ".github/prerelease", size: 2, encoding: "base64", content: "//8="},
    "2.0.0-alpha.1\n", "v2.0.0-alpha\n", "2.0.0-gamma\n", "2.0.0-alpha\nextra\n",
  ])
    await assert.rejects(readPrereleaseStage(repoApi({stage: badPayload}), {repository: "owner/project", sha, file: ".github/prerelease"}), ReleaseError);
});

test("numeric product metadata pairs with a pre-release stage file and graduates cleanly", () => fixture(async (file) => {
  const base = {repository: "owner/project", sha, files: [file("metadata.json", record("2.0.0"))], metadata: "metadata.json", prereleaseFile: ".github/prerelease"};
  assert.deepEqual(await resolveRelease(repoApi({tags: [tag("1.9.1")], stage: "2.0.0-alpha\n"}), base),
    {version: "2.0.0-alpha.1", prerelease: true, previousTag: "v1.9.1"});
  assert.deepEqual(await resolveRelease(repoApi({tags: [tag("2.0.0-alpha.1")], stage: "2.0.0-alpha"}), base),
    {version: "2.0.0-alpha.2", prerelease: true, previousTag: "v2.0.0-alpha.1"});
  assert.deepEqual(await resolveRelease(repoApi({tags: [tag("2.0.0-alpha.2")], stage: "2.0.0-beta"}), base),
    {version: "2.0.0-beta.1", prerelease: true, previousTag: "v2.0.0-alpha.2"});
  assert.deepEqual(await resolveRelease(repoApi({tags: [tag("2.0.0-rc.1")], stage: null}), base),
    {version: "2.0.0", prerelease: false, previousTag: "v2.0.0-rc.1"});
  await assert.rejects(resolveRelease(repoApi({tags: [tag("2.0.0")], stage: null}), base), UnversionedError);
  await assert.rejects(resolveRelease(repoApi({tags: [], stage: "2.1.0-alpha"}), base), /differs/);
  await assert.rejects(resolveRelease(repoApi({tags: [], stage: "2.0.0-alpha"}), {...base, explicit: "2.0.0"}), /explicit/);
  assert.equal(productVersion([file("m.json", record("2.0.0"))], "m.json", sha), "2.0.0");
  assert.throws(() => productVersion([file("m.json", record("2.0.0-alpha.1"))], "m.json", sha), ReleaseError);
  assert.deepEqual(await resolveRelease(repoApi({tags: [tag("2.0.0-alpha.1", sha)], stage: "2.0.0-alpha"}), base),
    {version: "2.0.0-alpha.1", prerelease: true, previousTag: null});
  await assert.rejects(resolveRelease(repoApi({tags: [tag("2.0.0-alpha.1", sha)], stage: "2.0.0-beta"}), base), /differs/);
  await assert.rejects(resolveRelease(repoApi({tags: [tag("2.0.0-alpha.1", sha)], stage: null}),
    {repository: "owner/project", sha, prereleaseFile: ".github/prerelease"}), /cleared/);
}));

test("release action publishes immutable pre-releases, stable releases and reconciles reruns", async (t) => {
  const started = new Date(Date.now() - 10000).toISOString();
  const runRecord = {
    id: 42, run_number: 5, run_attempt: 1, head_sha: sha, head_branch: "dev", event: "push",
    path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", run_started_at: started,
    repository: {full_name: "owner/project"}, head_repository: {full_name: "owner/project"},
  };
  async function exercise({stage, tags = [], existingRelease = null, prereleaseFile = ".github/prerelease"}) {
    const calls = [];
    let createdRelease = existingRelease;
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        calls.push({method: req.method, url: req.url, body});
        if (req.url.startsWith("/repos/owner/project/actions/workflows/ci.yml/runs"))
          return res.end(JSON.stringify({total_count: 1, workflow_runs: [runRecord]}));
        if (req.url.startsWith("/repos/owner/project/contents/.github/prerelease?ref=")) {
          if (stage === null) return res.writeHead(404).end();
          return res.end(JSON.stringify(content(".github/prerelease", stage)));
        }
        if (req.url === "/repos/owner/project/git/matching-refs/tags/v") return res.end(JSON.stringify(tags));
        if (req.url.startsWith("/repos/owner/project/git/ref/tags/")) {
          const found = tags.find((item) => item.ref === `refs/tags/${decodeURIComponent(req.url.split("/").at(-1))}`);
          return found ? res.end(JSON.stringify(found)) : res.writeHead(404).end();
        }
        if (req.method === "POST" && req.url === "/repos/owner/project/git/refs") return res.writeHead(201).end(JSON.stringify(body));
        if (req.url.startsWith("/repos/owner/project/releases/tags/"))
          return createdRelease && !createdRelease.draft ? res.end(JSON.stringify(createdRelease)) : res.writeHead(404).end();
        if (req.method === "GET" && req.url === "/repos/owner/project/releases?per_page=100")
          return res.end(JSON.stringify(createdRelease ? [createdRelease] : []));
        if (req.method === "POST" && req.url === "/repos/owner/project/releases/generate-notes")
          return res.end(JSON.stringify({body: "## Notes"}));
        if (req.method === "POST" && req.url === "/repos/owner/project/releases") {
          createdRelease = {id: 77, tag_name: body.tag_name, draft: body.draft, prerelease: body.prerelease, assets: [],
            html_url: `https://github.com/owner/project/releases/tag/${body.tag_name}`, upload_url: `${url}/upload{?name}`};
          return res.writeHead(201).end(JSON.stringify(createdRelease));
        }
        if (req.method === "PATCH" && req.url === "/repos/owner/project/releases/77") {
          createdRelease = {...createdRelease, ...body};
          return res.end(JSON.stringify(createdRelease));
        }
        res.writeHead(404).end();
      });
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    const dir = mkdtempSync(path.join(tmpdir(), "release-action-"));
    t.after(() => {
      rmSync(dir, {recursive: true, force: true});
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    const output = path.join(dir, "output"), summary = path.join(dir, "summary");
    const env = {
      GITHUB_REPOSITORY: "owner/project", GITHUB_SHA: sha, GITHUB_REF: "refs/heads/main",
      GITHUB_API_URL: url, RUNNER_TEMP: dir, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
      "INPUT_GITHUB-TOKEN": "fixture", "INPUT_WAIT-MINUTES": "0", "INPUT_PRERELEASE-FILE": prereleaseFile,
    };
    const result = await runRelease(env);
    return {calls, result, output: readFileSync(output, "utf8")};
  }

  const first = await exercise({stage: "2.0.0-alpha\n"});
  assert.equal(first.result.tag, "v2.0.0-alpha.1");
  assert.equal(first.result.prerelease, true);
  assert.match(first.output, /prerelease=true/);
  assert.deepEqual(first.calls.find((c) => c.url.endsWith("/generate-notes")).body, {tag_name: "v2.0.0-alpha.1", target_commitish: sha});
  assert.equal(first.calls.find((c) => c.method === "POST" && c.url.endsWith("/releases")).body.prerelease, true);
  assert.deepEqual(first.calls.find((c) => c.method === "PATCH").body, {draft: false, prerelease: true, make_latest: "false"});

  const second = await exercise({stage: "2.0.0-alpha\n", tags: [tag("2.0.0-alpha.1")]});
  assert.equal(second.result.tag, "v2.0.0-alpha.2");
  assert.equal(second.calls.find((c) => c.url.endsWith("/generate-notes")).body.previous_tag_name, "v2.0.0-alpha.1");

  const final = await exercise({stage: null, tags: [tag("2.0.0-rc.1")]});
  assert.equal(final.result.tag, "v2.0.0");
  assert.equal(final.result.prerelease, false);
  assert.match(final.output, /prerelease=false/);
  assert.equal(final.calls.find((c) => c.url.endsWith("/generate-notes")).body.previous_tag_name, undefined);
  assert.deepEqual(final.calls.find((c) => c.method === "PATCH").body, {draft: false, prerelease: false, make_latest: "true"});

  const rerun = await exercise({
    stage: "2.0.0-alpha",
    tags: [tag("2.0.0-alpha.1", sha)],
    existingRelease: {id: 77, tag_name: "v2.0.0-alpha.1", draft: false, prerelease: true, assets: [], html_url: "https://github.com/owner/project/releases/tag/v2.0.0-alpha.1"},
  });
  assert.equal(rerun.result.tag, "v2.0.0-alpha.1");
  assert.equal(rerun.calls.some((c) => c.method === "POST" || c.method === "PATCH"), false);

  await assert.rejects(exercise({
    stage: "2.0.0-alpha",
    tags: [tag("2.0.0-alpha.1", sha)],
    existingRelease: {id: 77, tag_name: "v2.0.0-alpha.1", draft: false, prerelease: false, assets: [], html_url: "https://github.com/owner/project/releases/tag/v2.0.0-alpha.1"},
  }), /disagrees on prerelease/);
});
