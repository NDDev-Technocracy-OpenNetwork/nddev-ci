import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  artifactTag,
  collectFiles,
  defaultChunkBytes,
  inspectOciArtifact,
  ociArchiveLayerMediaType,
  ociArtifactType,
  ociManifestMediaType,
  packDeterministicTarGz,
  packageName,
  pullOciArtifacts,
  pushOciArtifact,
  repositoryIsPrivate,
  retryableFetch,
  unpackSafeTarGz,
  validateOciArtifact,
} from "../lib/oci-artifacts.mjs";
import { client, transferArtifacts } from "../lib/qualification.mjs";

const execFileAsync = promisify(execFile);
const sha = (data) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const where = {
  repository: "Fixture-Org/Private-Project",
  sha: "a".repeat(40),
  workflowPath: ".github/workflows/ci.yml",
  branch: "dev",
  event: "push",
};

async function startHttp(handler) {
  const httpServer = createServer(handler);
  await new Promise((done) => httpServer.listen(0, "127.0.0.1", done));
  const { port } = httpServer.address();
  return {
    server: httpServer,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      httpServer.closeAllConnections();
      await new Promise((done) => httpServer.close(done));
    },
  };
}

async function startOciRegistry({
  failAuth = null,
  redirectStorage = true,
  mutateAfterPut = false,
  corruptBlob = false,
  maxPatchBytes = 4 * 1024 * 1024,
  badRange = false,
} = {}) {
  const blobs = new Map();
  const manifests = new Map();
  const uploads = new Map();
  const storageAuthHeaders = [];
  const headBlobHits = [];
  const patchRequests = [];
  let uploadCounter = 0;

  const storage = await startHttp((req, res) => {
    storageAuthHeaders.push(req.headers.authorization);
    const digest = decodeURIComponent(req.url.slice("/blobs/".length));
    const data = blobs.get(digest);
    if (!data) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(data.length) });
    res.end(corruptBlob ? Buffer.from("tampered-bytes") : data);
  });

  const registry = await startHttp(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/token") {
      const scope = url.searchParams.get("scope") ?? "";
      if (failAuth && scope.includes(failAuth)) { res.writeHead(403); res.end(); return; }
      assert.match(req.headers.authorization ?? "", /^Basic /);
      const token = `bearer-${scope}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token }));
      return;
    }

    assert.match(req.headers.authorization ?? "", /^Bearer bearer-/);
    const match = /^\/v2\/(.+?)\/(blobs|manifests)\/(.*)$/.exec(url.pathname);
    if (!match) { res.writeHead(404); res.end(); return; }
    const [, pkg, kind, rest] = match;

    if (kind === "blobs" && rest === "uploads/" && req.method === "POST") {
      const id = `u${++uploadCounter}`;
      uploads.set(id, []);
      res.writeHead(202, { Location: `/v2/${pkg}/blobs/uploads/${id}` });
      res.end();
      return;
    }

    if (kind === "blobs" && rest.startsWith("uploads/")) {
      const id = rest.slice("uploads/".length);
      const chunks = uploads.get(id);
      if (!chunks) { res.writeHead(404); res.end(); return; }
      const received = [];
      for await (const chunk of req) received.push(chunk);
      const body = Buffer.concat(received);
      if (req.method === "PATCH") {
        const offset = chunks.reduce((sum, c) => sum + c.length, 0);
        const contentRange = req.headers["content-range"] ?? "";
        const rangeMatch = /^(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(contentRange);
        const rangeOk = rangeMatch && Number(rangeMatch[1]) === offset && Number(rangeMatch[2]) === offset + body.length - 1;
        if (body.length > maxPatchBytes || !rangeOk) {
          res.writeHead(416, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            errors: [{ code: "REQUESTED_RANGE_NOT_SATISFIABLE", message: "request body or range rejected" }],
          }));
          return;
        }
        patchRequests.push({ length: body.length, contentRange });
        chunks.push(body);
        const total = offset + body.length;
        res.writeHead(202, {
          Location: `/v2/${pkg}/blobs/uploads/${id}`,
          Range: badRange ? "0-0" : `0-${Math.max(0, total - 1)}`,
        });
        res.end();
        return;
      }
      if (req.method === "PUT") {
        if (body.length) chunks.push(body);
        const digest = url.searchParams.get("digest");
        const full = Buffer.concat(chunks);
        if (sha(full) !== digest) { res.writeHead(400); res.end(); return; }
        blobs.set(digest, full);
        uploads.delete(id);
        res.writeHead(201, { "Docker-Content-Digest": digest });
        res.end();
        return;
      }
    }

    if (kind === "blobs") {
      const digest = decodeURIComponent(rest);
      const data = blobs.get(digest);
      if (req.method === "HEAD") {
        if (data) headBlobHits.push(digest);
        res.writeHead(data ? 200 : 404);
        res.end();
        return;
      }
      if (req.method === "GET") {
        if (!data) { res.writeHead(404); res.end(); return; }
        if (redirectStorage) {
          res.writeHead(307, { Location: `${storage.url}/blobs/${encodeURIComponent(digest)}` });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(corruptBlob ? Buffer.from("tampered-bytes") : data);
        return;
      }
    }

    if (kind === "manifests") {
      const ref = decodeURIComponent(rest);
      const key = `${pkg}:${ref}`;
      if (req.method === "HEAD") {
        const entry = manifests.get(key);
        res.writeHead(entry ? 200 : 404, entry ? { "Docker-Content-Digest": entry.digest } : {});
        res.end();
        return;
      }
      if (req.method === "PUT") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const digest = sha(body);
        if (mutateAfterPut) {
          const parsed = JSON.parse(body.toString("utf8"));
          parsed.annotations["org.nddev.ci.writer_id"] = "other-concurrent-writer";
          const replaced = Buffer.from(JSON.stringify(parsed));
          manifests.set(key, { bytes: replaced, digest: sha(replaced) });
        } else {
          manifests.set(key, { bytes: body, digest });
          manifests.set(`${pkg}:${digest}`, { bytes: body, digest });
        }
        res.writeHead(201, { "Docker-Content-Digest": digest });
        res.end();
        return;
      }
      if (req.method === "GET") {
        const entry = manifests.get(key);
        if (!entry) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { "Content-Type": ociManifestMediaType, "Docker-Content-Digest": entry.digest });
        res.end(entry.bytes);
        return;
      }
    }
    res.writeHead(405);
    res.end();
  });

  return {
    url: registry.url,
    blobs,
    manifests,
    storageAuthHeaders,
    headBlobHits,
    patchRequests,
    close: async () => { await registry.close(); await storage.close(); },
  };
}

test("repositoryIsPrivate reads INPUT_PRIVATE and GITHUB_EVENT_PATH and fails closed on malformed events", () => {
  const root = mkdtempSync(path.join(tmpdir(), "oci-vis-"));
  try {
    assert.equal(repositoryIsPrivate({}), false);
    assert.equal(repositoryIsPrivate({ INPUT_PRIVATE: "true" }), true);
    assert.equal(repositoryIsPrivate({ INPUT_PRIVATE: "false" }), false);
    const priv = path.join(root, "private.json");
    const pub = path.join(root, "public.json");
    const bad = path.join(root, "bad.json");
    writeFileSync(priv, JSON.stringify({ repository: { private: true } }));
    writeFileSync(pub, JSON.stringify({ repository: { private: false } }));
    writeFileSync(bad, "{not-json");
    assert.equal(repositoryIsPrivate({ GITHUB_EVENT_PATH: priv }), true);
    assert.equal(repositoryIsPrivate({ GITHUB_EVENT_PATH: pub }), false);
    assert.throws(() => repositoryIsPrivate({ GITHUB_EVENT_PATH: bad }), /visibility/);
    assert.throws(() => repositoryIsPrivate({ GITHUB_EVENT_PATH: path.join(root, "missing.json") }), /visibility/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("collectFiles supports single files, directories, multi-line globs and refuses symlinks or traversal", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oci-collect-"));
  try {
    const work = path.join(root, "work");
    mkdirSync(path.join(work, "dist", "sub"), { recursive: true });
    mkdirSync(path.join(work, "packages", "linux"), { recursive: true });
    const bin = path.join(work, "dist", "app");
    writeFileSync(bin, "binary-data");
    chmodSync(bin, 0o755);
    writeFileSync(path.join(work, "dist", "manifest.json"), "{}\n");
    writeFileSync(path.join(work, "dist", "sub", "nested.txt"), "nested");
    writeFileSync(path.join(work, "packages", "linux", "pkg.tar.gz"), "archive");
    writeFileSync(path.join(work, "packages", "root.json"), "root");

    const single = await collectFiles("dist/app", { cwd: work, allowedRoots: [work], topLevelOnly: true });
    assert.equal(single.length, 1);
    assert.equal(single[0].title, "app");
    if (process.platform !== "win32") assert.equal(single[0].executable, true);

    const dir = await collectFiles("dist", { cwd: work, allowedRoots: [work] });
    assert.deepEqual(dir.map((f) => f.title), ["app", "manifest.json", "sub/nested.txt"]);

    const globbed = await collectFiles("packages/root.json\npackages/*/*.tar.gz", { cwd: work, allowedRoots: [work] });
    assert.deepEqual(globbed.map((f) => f.title), ["linux/pkg.tar.gz", "root.json"]);

    const realTemp = path.join(root, "real-temp");
    const linkTemp = path.join(root, "link-temp");
    mkdirSync(path.join(realTemp, "sboms"), { recursive: true });
    symlinkSync(realTemp, linkTemp, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(path.join(realTemp, "sboms", "empty.txt"), "");
    const viaLinkRoot = await collectFiles(path.join(linkTemp, "sboms"), { cwd: work, allowedRoots: [work, linkTemp] });
    assert.deepEqual(viaLinkRoot.map((f) => [f.title, f.size]), [["empty.txt", 0]]);
    await assert.rejects(
      collectFiles(path.join(linkTemp, "sboms"), { cwd: work, allowedRoots: [work, linkTemp], topLevelOnly: true }),
      /empty/,
    );

    await assert.rejects(collectFiles("../outside", { cwd: work, allowedRoots: [work] }), /escapes/);
    symlinkSync(path.join(work, "dist"), path.join(work, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(collectFiles("linked", { cwd: work, allowedRoots: [work] }), /symbolic link/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("OCI push, chunked upload, deduplication, redirect credential isolation and digest pull work end to end", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oci-e2e-"));
  const reg = await startOciRegistry();
  try {
    const work = path.join(root, "work");
    mkdirSync(path.join(work, "dist"), { recursive: true });
    const binary = Buffer.alloc(180, 0x41);
    const binPath = path.join(work, "dist", "tool");
    writeFileSync(binPath, binary);
    chmodSync(binPath, 0o755);
    writeFileSync(path.join(work, "dist", "meta.json"), JSON.stringify({ schema_version: 1, source_commit: where.sha, version: "1.2.3" }));

    // Force multi-chunk PATCH + PUT with chunkBytes: 64.
    const pushed = await pushOciArtifact({
      repository: where.repository,
      sha: where.sha,
      branch: where.branch,
      runId: 42,
      runAttempt: 1,
      name: "release-bin",
      part: "verify: build",
      pathsText: "dist",
      cwd: work,
      allowedRoots: [work],
      token: "ghs_secret_fixture_token",
      actor: "rldyourmnd",
      registryUrl: reg.url,
      chunkBytes: 64,
    });
    assert.equal(pushed.package, packageName(where.repository));
    assert.equal(pushed.tag, artifactTag(42, 1, "release-bin"));
    assert.match(pushed.digest, /^sha256:[0-9a-f]{64}$/);

    // Duplicate upload under the same name in the same attempt is refused.
    await assert.rejects(pushOciArtifact({
      repository: where.repository, sha: where.sha, branch: where.branch, runId: 42, runAttempt: 1,
      name: "release-bin", pathsText: "dist", cwd: work, allowedRoots: [work],
      token: "ghs_secret_fixture_token", registryUrl: reg.url,
    }), /already uploaded/);

    // A second artifact with identical files deduplicates blobs via HEAD 200.
    const second = await pushOciArtifact({
      repository: where.repository, sha: where.sha, branch: where.branch, runId: 42, runAttempt: 1,
      name: "release-copy", pathsText: "dist", cwd: work, allowedRoots: [work],
      token: "ghs_secret_fixture_token", registryUrl: reg.url,
    });
    assert.ok(reg.headBlobHits.includes(sha(binary)));

    // Inspect verifies part annotation and binding.
    const inspected = await inspectOciArtifact({
      repository: where.repository, sha: where.sha, branch: where.branch, runId: 42, runAttempt: 1,
      nameOrDigest: "release-bin", token: "ghs_secret_fixture_token", registryUrl: reg.url,
    });
    assert.equal(inspected.part, "verify: build");
    assert.equal(inspected.digest, pushed.digest);

    // Pull by name and by explicit digest; storage redirects never receive credentials.
    const destByName = path.join(root, "pulled-name");
    const pulled = await pullOciArtifacts({
      repository: where.repository, sha: where.sha, branch: where.branch, runId: 42, runAttempt: 1,
      names: ["release-bin"], destination: destByName, topLevelOnly: true,
      token: "ghs_secret_fixture_token", registryUrl: reg.url,
    });
    assert.equal(pulled.files.length, 2);
    assert.deepEqual(readFileSync(path.join(destByName, "tool")), binary);
    if (process.platform !== "win32") assert.equal(statSync(path.join(destByName, "tool")).mode & 0o100, 0o100);
    assert.ok(reg.storageAuthHeaders.length >= 2);
    assert.ok(reg.storageAuthHeaders.every((header) => header === undefined));

    const destByDigest = path.join(root, "pulled-digest");
    const byDigest = await pullOciArtifacts({
      repository: where.repository, sha: where.sha, branch: where.branch, runId: 42, runAttempt: 1,
      names: [second.digest], destination: destByDigest, topLevelOnly: true,
      token: "ghs_secret_fixture_token", registryUrl: reg.url,
    });
    assert.equal(byDigest.artifacts[0].digest, second.digest);
    assert.equal(existsSync(path.join(destByDigest, "meta.json")), true);

    // Wrong source commit or stale attempt timestamp is refused without leaving partial output.
    await assert.rejects(pullOciArtifacts({
      repository: where.repository, sha: "b".repeat(40), branch: where.branch, runId: 42, runAttempt: 1,
      names: ["release-bin"], destination: path.join(root, "wrong-sha"), topLevelOnly: true,
      token: "ghs_secret_fixture_token", registryUrl: reg.url,
    }), /differs/);
    assert.equal(existsSync(path.join(root, "wrong-sha")), false);

    await assert.rejects(pullOciArtifacts({
      repository: where.repository, sha: where.sha, branch: where.branch, runId: 42, runAttempt: 1,
      minCreatedAt: new Date(Date.now() + 60000).toISOString(),
      names: ["release-bin"], destination: path.join(root, "stale"), topLevelOnly: true,
      token: "ghs_secret_fixture_token", registryUrl: reg.url,
    }), /stale/);
    assert.equal(existsSync(path.join(root, "stale")), false);
  } finally {
    await reg.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("OCI chunked upload stays within GHCR's 4 MiB PATCH limit by default and rejects oversized chunks or mismatched ranges", async () => {
  assert.equal(defaultChunkBytes, 4 * 1024 * 1024);
  const root = mkdtempSync(path.join(tmpdir(), "oci-chunk-limit-"));
  const reg = await startOciRegistry();
  const brokenRange = await startOciRegistry({ badRange: true });
  try {
    const work = path.join(root, "work");
    mkdirSync(path.join(work, "dist"), { recursive: true });
    const size = 9 * 1024 * 1024 + 123;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size - 4; i += 4096) payload.writeUInt32BE(i, i);
    writeFileSync(path.join(work, "dist", "bundle.tar.gz"), payload);

    const pushed = await pushOciArtifact({
      repository: where.repository,
      sha: where.sha,
      branch: where.branch,
      runId: 91,
      runAttempt: 1,
      name: "large-bundle",
      pathsText: "dist/bundle.tar.gz",
      cwd: work,
      allowedRoots: [work],
      token: "ghs_secret_fixture_token",
      registryUrl: reg.url,
    });
    assert.deepEqual(
      reg.patchRequests,
      [
        { length: 4 * 1024 * 1024, contentRange: "0-4194303" },
        { length: 4 * 1024 * 1024, contentRange: "4194304-8388607" },
        { length: 1 * 1024 * 1024 + 123, contentRange: "8388608-9437306" },
      ],
    );

    const dest = path.join(root, "pulled-large");
    await pullOciArtifacts({
      repository: where.repository,
      sha: where.sha,
      branch: where.branch,
      runId: 91,
      runAttempt: 1,
      names: [pushed.digest],
      destination: dest,
      topLevelOnly: true,
      token: "ghs_secret_fixture_token",
      registryUrl: reg.url,
    });
    assert.equal(sha(readFileSync(path.join(dest, "bundle.tar.gz"))), sha(payload));

    const overLimit = Buffer.alloc(5 * 1024 * 1024, 0x5a);
    writeFileSync(path.join(work, "dist", "oversized.bin"), overLimit);
    await assert.rejects(pushOciArtifact({
      repository: where.repository,
      sha: where.sha,
      branch: where.branch,
      runId: 91,
      runAttempt: 1,
      name: "oversized-chunk",
      pathsText: "dist/oversized.bin",
      cwd: work,
      allowedRoots: [work],
      token: "ghs_secret_fixture_token",
      registryUrl: reg.url,
      chunkBytes: 8 * 1024 * 1024,
    }), /HTTP 416 \(REQUESTED_RANGE_NOT_SATISFIABLE\)/);

    writeFileSync(path.join(work, "dist", "small.bin"), Buffer.alloc(180, 0x33));
    await assert.rejects(pushOciArtifact({
      repository: where.repository,
      sha: where.sha,
      branch: where.branch,
      runId: 91,
      runAttempt: 1,
      name: "bad-range",
      pathsText: "dist/small.bin",
      cwd: work,
      allowedRoots: [work],
      token: "ghs_secret_fixture_token",
      registryUrl: brokenRange.url,
      chunkBytes: 64,
    }), /unexpected range/);
  } finally {
    await reg.close();
    await brokenRange.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("OCI transfer refuses concurrent overwrite, tampered blobs and missing packages permission without leaking tokens", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oci-neg-"));
  const work = path.join(root, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "item.txt"), "hello");
  const secretToken = "ghs_do_not_leak_this_token";

  const authFail = await startOciRegistry({ failAuth: "push" });
  const raced = await startOciRegistry({ mutateAfterPut: true });
  const corrupted = await startOciRegistry({ corruptBlob: true });
  try {
    await assert.rejects(pushOciArtifact({
      repository: where.repository, sha: where.sha, branch: where.branch, runId: 1, runAttempt: 1,
      name: "build", pathsText: "item.txt", cwd: work, allowedRoots: [work],
      token: secretToken, registryUrl: authFail.url,
    }), (err) => {
      assert.match(err.message, /packages: write/);
      assert.doesNotMatch(err.message, new RegExp(secretToken));
      return true;
    });

    await assert.rejects(pushOciArtifact({
      repository: where.repository, sha: where.sha, branch: where.branch, runId: 1, runAttempt: 1,
      name: "build", pathsText: "item.txt", cwd: work, allowedRoots: [work],
      token: secretToken, registryUrl: raced.url,
    }), /concurrently|overwritten/);

    await pushOciArtifact({
      repository: where.repository, sha: where.sha, branch: where.branch, runId: 1, runAttempt: 1,
      name: "build", pathsText: "item.txt", cwd: work, allowedRoots: [work],
      token: secretToken, registryUrl: corrupted.url,
    });
    await assert.rejects(pullOciArtifacts({
      repository: where.repository, sha: where.sha, branch: where.branch, runId: 1, runAttempt: 1,
      names: ["build"], destination: path.join(root, "out"), topLevelOnly: true,
      token: secretToken, registryUrl: corrupted.url,
    }), /differ|exceeds/);
    assert.equal(existsSync(path.join(root, "out")), false);
  } finally {
    await authFail.close();
    await raced.close();
    await corrupted.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("private promote, checked-artifacts, release and oci-artifact actions use GHCR and never hit Actions artifacts API", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oci-actions-"));
  const reg = await startOciRegistry();
  const work = path.join(root, "work");
  const temp = path.join(root, "temp");
  mkdirSync(path.join(work, "dist"), { recursive: true });
  mkdirSync(temp, { recursive: true });
  const started = new Date(Date.now() - 10000).toISOString();
  const metadata = { schema_version: 1, source_commit: where.sha, version: "2.1.0" };
  writeFileSync(path.join(work, "dist", "qualification.json"), JSON.stringify(metadata));
  writeFileSync(path.join(work, "dist", "app.tar.gz"), "release-archive-bytes");
  const eventPath = path.join(root, "event.json");
  writeFileSync(eventPath, JSON.stringify({ repository: { private: true } }));

  const runRow = {
    id: 77, run_number: 5, run_attempt: 1, head_sha: where.sha, head_branch: "dev", event: "push",
    path: where.workflowPath, status: "completed", conclusion: "success", run_started_at: started,
    repository: { full_name: where.repository }, head_repository: { full_name: where.repository },
  };
  let actionsArtifactsCalls = 0;
  const tags = [{ ref: "refs/tags/v2.0.0", object: { type: "commit", sha: "b".repeat(40) } }];
  let release = null;
  const api = await startHttp(async (req, res) => {
    const buffers = [];
    for await (const piece of req) buffers.push(piece);
    const payload = Buffer.concat(buffers);
    const pathname = req.url;
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (pathname.includes("/actions/runs/") && pathname.includes("/artifacts")) {
      actionsArtifactsCalls++;
      return send(500, { message: "forbidden in private test" });
    }
    if (pathname.includes("/workflows/")) return send(200, { total_count: 1, workflow_runs: [runRow] });
    if (pathname.endsWith("/branches/dev")) return send(200, { name: "dev", commit: { sha: where.sha } });
    if (pathname.endsWith("/branches/main")) return send(200, { name: "main", commit: { sha: "b".repeat(40) } });
    if (pathname.includes("/compare/")) {
      return send(200, {
        ahead_by: 1, behind_by: 0, total_commits: 1,
        base_commit: { sha: "b".repeat(40) }, merge_base_commit: { sha: "b".repeat(40) },
        commits: [{ sha: where.sha }],
      });
    }
    if (pathname.endsWith("/matching-refs/tags/v")) return send(200, tags);
    if (pathname.endsWith("/git/ref/tags/v2.1.0")) return send(404, {});
    if (pathname.endsWith("/git/refs")) {
      const created = { ref: "refs/tags/v2.1.0", object: { type: "commit", sha: where.sha } };
      tags.push(created);
      return send(201, created);
    }
    if (pathname.endsWith("/releases/tags/v2.1.0")) return send(release ? 200 : 404, release ?? {});
    if (pathname.includes("/releases?per_page=100")) return send(200, []);
    if (pathname.endsWith("/releases/generate-notes")) return send(200, { body: "Changes" });
    if (pathname.endsWith("/releases") && req.method === "POST") {
      release = {
        ...JSON.parse(payload),
        id: 9,
        assets: [],
        upload_url: `${api.url}/upload{?name}`,
        html_url: "https://github.com/Fixture-Org/Private-Project/releases/tag/v2.1.0",
      };
      return send(201, release);
    }
    if (pathname.startsWith("/upload?")) {
      const assetName = new URL(pathname, api.url).searchParams.get("name");
      const uploaded = { name: assetName, size: payload.length, digest: sha(payload) };
      release.assets.push(uploaded);
      return send(201, uploaded);
    }
    if (pathname.endsWith("/releases/9") && req.method === "PATCH") {
      Object.assign(release, JSON.parse(payload));
      return send(200, release);
    }
    res.writeHead(404);
    res.end();
  });

  try {
    // 1. Push via actions/oci-artifact
    const { main: ociAction } = await import("../actions/oci-artifact/run.mjs");
    const pushOut = path.join(temp, "push-out");
    const pushResult = await ociAction({
      GITHUB_REPOSITORY: where.repository, GITHUB_SHA: where.sha, GITHUB_REF_NAME: "dev",
      GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1", GITHUB_WORKSPACE: work, RUNNER_TEMP: temp,
      GITHUB_ACTOR: "rldyourmnd", GITHUB_OUTPUT: pushOut,
      INPUT_MODE: "push", INPUT_NAME: "release", INPUT_PATH: "dist", INPUT_PART: "verify: package",
      "INPUT_GITHUB-TOKEN": "ghs_test", "INPUT_REGISTRY-URL": reg.url,
    });
    assert.match(readFileSync(pushOut, "utf8"), new RegExp(`digest=${pushResult.digest}`));

    // 2. Verify via actions/oci-artifact
    const verifyOut = path.join(temp, "verify-out");
    const verified = await ociAction({
      GITHUB_REPOSITORY: where.repository, GITHUB_SHA: where.sha, GITHUB_REF_NAME: "dev",
      GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1", RUNNER_TEMP: temp, GITHUB_OUTPUT: verifyOut,
      INPUT_MODE: "verify", INPUT_NAME: "release", "INPUT_GITHUB-TOKEN": "ghs_test", "INPUT_REGISTRY-URL": reg.url,
    });
    assert.equal(verified.part, "verify: package");

    // 3. Pull via actions/oci-artifact (e.g. security.yml caller SBOMs)
    const pullOut = path.join(temp, "pull-out");
    await ociAction({
      GITHUB_REPOSITORY: where.repository, GITHUB_SHA: where.sha, GITHUB_REF_NAME: "dev",
      GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1", RUNNER_TEMP: temp, GITHUB_OUTPUT: pullOut,
      INPUT_MODE: "pull", INPUT_NAME: "release", INPUT_DIRECTORY: path.join(temp, "caller-sboms"),
      "INPUT_GITHUB-TOKEN": "ghs_test", "INPUT_REGISTRY-URL": reg.url,
    });
    assert.equal(readFileSync(path.join(temp, "caller-sboms", "app.tar.gz"), "utf8"), "release-archive-bytes");

    // 4. Promote via actions/promote
    const { main: promoteAction } = await import("../actions/promote/run.mjs");
    const promoteOut = path.join(temp, "promote-out");
    const promoted = await promoteAction({
      ...process.env,
      GITHUB_REPOSITORY: where.repository, GITHUB_API_URL: api.url, GITHUB_EVENT_PATH: eventPath,
      RUNNER_TEMP: temp, GITHUB_OUTPUT: promoteOut, NDDEV_CI_OCI_REGISTRY_URL: reg.url,
      "INPUT_GITHUB-TOKEN": "ghs_test", INPUT_ARTIFACTS: "release", "INPUT_RELEASE-METADATA": "qualification.json",
    });
    assert.equal(promoted.state, "ready");
    assert.equal(promoted.version, "2.1.0");

    // 5. Transfer via actions/checked-artifacts
    const { main: checkedAction } = await import("../actions/checked-artifacts/run.mjs");
    const checkedOut = path.join(temp, "checked-out");
    const qualified = { schema_version: 1, ...where, run_id: 77, run_number: 5, run_attempt: 1, run_started_at: started };
    await checkedAction({
      ...process.env,
      GITHUB_EVENT_PATH: eventPath, RUNNER_TEMP: temp, GITHUB_OUTPUT: checkedOut,
      NDDEV_CI_OCI_REGISTRY_URL: reg.url,
      INPUT_RECEIPT: JSON.stringify(qualified), INPUT_ARTIFACTS: "release",
      INPUT_DIRECTORY: "checked-oci", "INPUT_API-URL": api.url, "INPUT_GITHUB-TOKEN": "ghs_test",
    });
    assert.equal(readFileSync(path.join(temp, "checked-oci", "app.tar.gz"), "utf8"), "release-archive-bytes");

    // 6. Release via actions/release
    const releaseTemp = mkdtempSync(path.join(root, "rel-"));
    const releaseScript = fileURLToPath(new URL("../actions/release/run.mjs", import.meta.url));
    const releaseEnv = Object.assign({}, process.env, {
      GITHUB_REPOSITORY: where.repository,
      GITHUB_SHA: where.sha,
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: eventPath,
      RUNNER_TEMP: releaseTemp,
      GITHUB_API_URL: api.url,
      GITHUB_SERVER_URL: "https://github.com",
      NDDEV_CI_OCI_REGISTRY_URL: reg.url,
      "INPUT_API-URL": api.url,
      "INPUT_GITHUB-TOKEN": "ghs_test",
      "INPUT_WAIT-MINUTES": "0",
      INPUT_ARTIFACTS: "release",
      "INPUT_RELEASE-METADATA": "qualification.json",
      GITHUB_OUTPUT: path.join(releaseTemp, "outputs"),
      GITHUB_STEP_SUMMARY: path.join(releaseTemp, "summary"),
    });
    await execFileAsync(process.execPath, [releaseScript], { env: releaseEnv, timeout: 10000 });
    assert.equal(release.draft, false);
    assert.deepEqual(release.assets.map((a) => a.name).sort(), ["SHA256SUMS", "app.tar.gz", "qualification.json"]);
    assert.equal(actionsArtifactsCalls, 0, "private repository must never call Actions artifacts API");

    // Verify transferArtifacts directly too.
    const directDest = path.join(root, "direct-oci");
    const direct = await transferArtifacts(client("ghs_test", api.url), qualified, "release", directDest, {
      private: true, githubToken: "ghs_test", registryUrl: reg.url,
    });
    assert.equal(direct.artifacts[0].digest, pushResult.digest);
    assert.equal(actionsArtifactsCalls, 0);
  } finally {
    await api.close();
    await reg.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("every upload-artifact and download-artifact step or job in the library is gated to public repositories only", () => {
  const root = new URL("../", import.meta.url);
  const files = [
    ...readdirSync(new URL(".github/workflows/", root)).map((name) => `.github/workflows/${name}`),
    ...readdirSync(new URL("actions/", root)).map((name) => `actions/${name}/action.yml`),
  ];
  let checked = 0;
  for (const rel of files) {
    const lines = readFileSync(new URL(rel, root), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/uses:\s*actions\/(upload|download)-artifact@/.test(lines[i])) continue;
      checked++;
      // Look backward within the enclosing step or job header for `!github.event.repository.private`.
      let guarded = false;
      const stepIndent = lines[i].match(/^(\s*)/)[1].length;
      for (let j = i - 1; j >= 0; j--) {
        const line = lines[j];
        if (/!github\.event\.repository\.private/.test(line) && /^\s+if:/.test(line)) {
          guarded = true;
          break;
        }
        // Stop scanning backward once we leave the enclosing job.
        if (stepIndent >= 4 && /^  [a-z][a-z0-9-]*:$/.test(line)) break;
      }
      assert.ok(guarded, `${rel}:${i + 1} uses actions/upload-artifact or download-artifact without !github.event.repository.private`);
    }
  }
  assert.ok(checked >= 9, `expected at least 9 artifact action sites, checked ${checked}`);
});

test("unretried OCI transport failures report sanitized error codes without leaking secrets", async () => {
  const errWithCode = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket"), { code }) });
  await assert.rejects(
    retryableFetch(() => Promise.reject(errWithCode("ECONNRESET")), { retry: false }),
    /The OCI registry transport did not complete \(ECONNRESET\)\./,
  );
  await assert.rejects(
    retryableFetch(() => Promise.reject(errWithCode("CERT_HAS_EXPIRED")), { retry: false }),
    /The OCI registry transport did not complete \(CERT_HAS_EXPIRED\)\./,
  );
  const aggregate = Object.assign(new TypeError("fetch failed"), {
    cause: new AggregateError([Object.assign(new Error("refused"), { code: "ECONNREFUSED" })], "aggregate"),
  });
  await assert.rejects(
    retryableFetch(() => Promise.reject(aggregate), { retry: false }),
    /The OCI registry transport did not complete \(ECONNREFUSED\)\./,
  );
  await assert.rejects(
    retryableFetch(() => Promise.reject(errWithCode("ghs_secret_token_should_not_appear")), { retry: false }),
    (err) => {
      assert.match(err.message, /The OCI registry transport did not complete \(unclassified transport error\)\./);
      assert.doesNotMatch(err.message, /ghs_secret_token/);
      return true;
    },
  );
  // Keep the event loop referenced while awaiting AbortSignal.timeout on older Node runtimes.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      retryableFetch((signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }), { retry: false, timeout: 40 }),
      /The OCI registry transport did not complete \(request timeout\)\./,
    );
  } finally {
    clearTimeout(keepAlive);
  }

  const root = mkdtempSync(path.join(tmpdir(), "oci-drop-"));
  const work = path.join(root, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, "item.txt"), "payload");
  const secretToken = "ghs_secret_upload_token";
  const dropper = await startHttp((req, res) => {
    if (req.url.startsWith("/token")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: "bearer-drop" }));
      return;
    }
    if (req.method === "HEAD") { res.writeHead(404); res.end(); return; }
    req.socket.destroy();
  });
  try {
    await assert.rejects(pushOciArtifact({
      repository: where.repository, sha: where.sha, branch: where.branch, runId: 5, runAttempt: 1,
      name: "drop", pathsText: "item.txt", cwd: work, allowedRoots: [work],
      token: secretToken, registryUrl: dropper.url,
    }), (err) => {
      assert.match(err.message, /The OCI registry transport did not complete \([A-Z0-9_]+\)\./);
      assert.doesNotMatch(err.message, new RegExp(secretToken));
      return true;
    });
  } finally {
    await dropper.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("OCI push packs directories over 128 files into one deterministic tar+gzip layer and unpacks or retains it by mode", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "oci-bundle-"));
  const reg = await startOciRegistry();
  try {
    const work = path.join(root, "work");
    const siteDir = path.join(work, "dist");
    mkdirSync(path.join(siteDir, "_astro", "chunks"), { recursive: true });
    mkdirSync(path.join(siteDir, "nested", "very-long-directory-segment-for-pax-testing", "another-long-directory-segment-here"), { recursive: true });

    // Create 136 files including underscore directories (_astro), >100-byte PAX path, empty file and executable script.
    const longRel = "nested/very-long-directory-segment-for-pax-testing/another-long-directory-segment-here/long-named-asset-file-1234567890.json";
    writeFileSync(path.join(siteDir, longRel), "{\"pax\":true}\n");
    writeFileSync(path.join(siteDir, "_astro", "chunks", "empty.txt"), "");
    const scriptPath = path.join(siteDir, "_astro", "chunks", "run.sh");
    writeFileSync(scriptPath, "#!/bin/sh\necho ok\n");
    chmodSync(scriptPath, 0o755);
    for (let i = 0; i < 133; i++) {
      writeFileSync(
        path.join(siteDir, "_astro", "chunks", `chunk-${String(i).padStart(3, "0")}.js`),
        `export const id = ${i};\n`,
      );
    }

    // Validate mode checks the tree without touching GHCR.
    const validated = await validateOciArtifact({
      name: "site-dist",
      pathsText: "dist",
      cwd: work,
      allowedRoots: [work],
    });
    assert.equal(validated.files.length, 136);
    assert.equal(validated.bundled, true);

    const { main: ociAction } = await import("../actions/oci-artifact/run.mjs");
    const validateResult = await ociAction({
      GITHUB_WORKSPACE: work,
      RUNNER_TEMP: root,
      INPUT_MODE: "validate",
      INPUT_NAME: "site-dist",
      INPUT_PATH: "dist",
    });
    assert.equal(validateResult.bundled, true);
    assert.equal(validateResult.files.length, 136);

    // Push twice under different artifact names to prove byte-for-byte deterministic tar+gzip digests.
    const first = await pushOciArtifact({
      repository: where.repository,
      sha: where.sha,
      branch: where.branch,
      runId: 301,
      runAttempt: 1,
      name: "site-dist",
      part: "verify: build",
      pathsText: "dist",
      cwd: work,
      allowedRoots: [work],
      token: "ghs_bundle_token",
      registryUrl: reg.url,
    });
    assert.equal(first.bundled, true);
    assert.equal(first.archiveTitle, "site-dist.tar.gz");
    assert.equal(first.files.length, 136);

    const second = await pushOciArtifact({
      repository: where.repository,
      sha: where.sha,
      branch: where.branch,
      runId: 301,
      runAttempt: 1,
      name: "site-dist-copy",
      part: "verify: build",
      pathsText: "dist",
      cwd: work,
      allowedRoots: [work],
      token: "ghs_bundle_token",
      registryUrl: reg.url,
    });
    assert.equal(second.archiveDigest, first.archiveDigest);
    assert.equal(second.archiveSize, first.archiveSize);
    assert.ok(reg.headBlobHits.includes(first.archiveDigest));

    // Verify OCI manifest structure matches both standard OCI readers and strict manifest validators.
    const inspected = await inspectOciArtifact({
      repository: where.repository,
      sha: where.sha,
      branch: where.branch,
      runId: 301,
      runAttempt: 1,
      nameOrDigest: "site-dist",
      token: "ghs_bundle_token",
      registryUrl: reg.url,
    });
    assert.equal(inspected.manifest.schemaVersion, 2);
    assert.equal(inspected.manifest.mediaType, ociManifestMediaType);
    assert.equal(inspected.manifest.artifactType, ociArtifactType);
    assert.equal(inspected.manifest.layers.length, 1);
    assert.equal(inspected.manifest.layers[0].mediaType, ociArchiveLayerMediaType);
    assert.equal(inspected.manifest.layers[0].annotations["org.opencontainers.image.title"], "site-dist.tar.gz");
    assert.equal(inspected.manifest.layers[0].annotations["org.nddev.ci.archive"], "tar+gzip");
    assert.equal(inspected.manifest.layers[0].annotations["org.nddev.ci.file_count"], "136");
    assert.equal(inspected.manifest.annotations["org.nddev.ci.archive"], "tar+gzip");
    assert.equal(inspected.manifest.annotations["org.nddev.ci.file_count"], "136");

    // topLevelOnly: false unpacks all 136 files including PAX paths, empty files and executable bits.
    const unpackedDir = path.join(root, "unpacked");
    const unpacked = await pullOciArtifacts({
      repository: where.repository,
      sha: where.sha,
      branch: where.branch,
      runId: 301,
      runAttempt: 1,
      names: ["site-dist"],
      destination: unpackedDir,
      topLevelOnly: false,
      token: "ghs_bundle_token",
      registryUrl: reg.url,
    });
    assert.equal(unpacked.files.length, 136);
    assert.equal(readFileSync(path.join(unpackedDir, longRel), "utf8"), "{\"pax\":true}\n");
    assert.equal(readFileSync(path.join(unpackedDir, "_astro", "chunks", "empty.txt"), "utf8"), "");
    assert.equal(readFileSync(path.join(unpackedDir, "_astro", "chunks", "chunk-042.js"), "utf8"), "export const id = 42;\n");
    if (process.platform !== "win32") {
      assert.equal(statSync(path.join(unpackedDir, "_astro", "chunks", "run.sh")).mode & 0o100, 0o100);
    }

    // topLevelOnly: true keeps the single top-level tar+gzip archive intact for release/controller consumers.
    const topLevelDir = path.join(root, "top-level");
    const topLevel = await pullOciArtifacts({
      repository: where.repository,
      sha: where.sha,
      branch: where.branch,
      runId: 301,
      runAttempt: 1,
      names: ["site-dist"],
      destination: topLevelDir,
      topLevelOnly: true,
      token: "ghs_bundle_token",
      registryUrl: reg.url,
    });
    assert.deepEqual(topLevel.files.map((f) => f.name), ["site-dist.tar.gz"]);
    assert.equal(sha(readFileSync(path.join(topLevelDir, "site-dist.tar.gz"))), first.archiveDigest);

    // Exactly 128 files stays unbundled (per-file layers).
    const smallDir = path.join(work, "exact128");
    mkdirSync(smallDir, { recursive: true });
    for (let i = 0; i < 128; i++) writeFileSync(path.join(smallDir, `f-${String(i).padStart(3, "0")}.txt`), `v${i}`);
    const unbundled = await pushOciArtifact({
      repository: where.repository,
      sha: where.sha,
      branch: where.branch,
      runId: 301,
      runAttempt: 1,
      name: "exact-128",
      pathsText: "exact128",
      cwd: work,
      allowedRoots: [work],
      token: "ghs_bundle_token",
      registryUrl: reg.url,
    });
    assert.equal(unbundled.bundled, false);
    const smallInspected = await inspectOciArtifact({
      repository: where.repository,
      sha: where.sha,
      branch: where.branch,
      runId: 301,
      runAttempt: 1,
      nameOrDigest: "exact-128",
      token: "ghs_bundle_token",
      registryUrl: reg.url,
    });
    assert.equal(smallInspected.manifest.layers.length, 128);
    assert.equal(smallInspected.manifest.annotations["org.nddev.ci.archive"], undefined);
  } finally {
    await reg.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unpackSafeTarGz rejects symlinks, traversal, bad checksums, duplicates and truncated archives", async () => {
  const { gzipSync } = await import("node:zlib");
  const root = mkdtempSync(path.join(tmpdir(), "oci-tar-sec-"));
  const makeHeader = (name, { size = 0, typeflag = "0", badChecksum = false } = {}) => {
    const h = Buffer.alloc(512, 0);
    Buffer.from(name, "utf8").copy(h, 0);
    h.write("0000644\0", 100, 8, "ascii");
    h.write("0000000\0", 108, 8, "ascii");
    h.write("0000000\0", 116, 8, "ascii");
    h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    h.write("00000000000\0", 136, 12, "ascii");
    h.fill(0x20, 148, 156);
    h.write(typeflag, 156, 1, "ascii");
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    if (badChecksum) sum += 7;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    return h;
  };
  const eof = Buffer.alloc(1024, 0);
  const runCase = async (label, rawTar) => {
    const archive = path.join(root, `${label}.tar.gz`);
    const stage = path.join(root, `stage-${label}`);
    mkdirSync(stage, { recursive: true });
    writeFileSync(archive, gzipSync(rawTar));
    const state = { files: [], seen: new Set(), total: 0 };
    return unpackSafeTarGz(archive, stage, path.join(root, `dest-${label}`), state);
  };
  try {
    await assert.rejects(runCase("symlink", Buffer.concat([makeHeader("link", { typeflag: "2" }), eof])), /regular files/);
    await assert.rejects(runCase("hardlink", Buffer.concat([makeHeader("hard", { typeflag: "1" }), eof])), /regular files/);
    await assert.rejects(runCase("traversal", Buffer.concat([makeHeader("../escape.txt"), eof])), /invalid file name/);
    await assert.rejects(runCase("absolute", Buffer.concat([makeHeader("/etc/passwd"), eof])), /unsafe path/);
    await assert.rejects(runCase("hidden", Buffer.concat([makeHeader(".env"), eof])), /invalid file name/);
    await assert.rejects(runCase("checksum", Buffer.concat([makeHeader("ok.txt", { badChecksum: true }), eof])), /checksum/);
    await assert.rejects(runCase("duplicate", Buffer.concat([makeHeader("Dup.txt"), makeHeader("dup.txt"), eof])), /repeated/);
    await assert.rejects(runCase("truncated", Buffer.concat([makeHeader("cut.txt", { size: 512 }), Buffer.alloc(100, 0x41)])), /mid-entry|truncated/);
    await assert.rejects(runCase("empty", eof), /no regular files/);
    // Also verify packDeterministicTarGz directly produces valid output on single file.
    const src = path.join(root, "plain.txt");
    writeFileSync(src, "hello\n");
    const packed = await packDeterministicTarGz(
      [{ title: "plain.txt", path: src, size: 6, executable: false }],
      path.join(root, "single.tar.gz"),
    );
    const stageOk = path.join(root, "stage-ok");
    mkdirSync(stageOk, { recursive: true });
    const stateOk = { files: [], seen: new Set(), total: 0 };
    const out = await unpackSafeTarGz(packed.path, stageOk, path.join(root, "dest-ok"), stateOk);
    assert.equal(out.length, 1);
    assert.equal(readFileSync(path.join(stageOk, "plain.txt"), "utf8"), "hello\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
