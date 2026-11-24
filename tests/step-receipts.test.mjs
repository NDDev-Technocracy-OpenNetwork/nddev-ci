import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { record } from "../actions/job-record/run.mjs";
import { finish as checkFinish, prepare as checkPrepare, resolvePublic } from "../actions/project-check/receipts.mjs";
import { main as recipeMain } from "../actions/recipe/run.mjs";
import { main as stepReceiptMain } from "../actions/step-receipt/run.mjs";
import {
  buildPublicReceiptStatement,
  checkIdForArgv,
  classifyPathBypass,
  computeInputDigest,
  computeToolchainAndRunnerDigests,
  evaluateBypass,
  formatReceiptSummary,
  gitTreeState,
  inspectVerifyDecomposition,
  isArtifactProducingPart,
  isReleaseRef,
  planMatchesTarget,
  recipeClosureDigest,
  sanitizeProjectEnv,
  selectCanary,
  signDsseEnvelope,
  targetRunnerForPart,
  verifySignedReceipt,
} from "../lib/step-receipts.mjs";

const withJust = { skip: spawnSync("just", ["--version"]).status === 0 ? false : "just is not on PATH" };
const wfSha = "a".repeat(40);
const otherWfSha = "b".repeat(40);
const baseSha = "1".repeat(40);
const headSha = "2".repeat(40);

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

function makeRepo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "step-receipts-repo-"));
  git(dir, ["init", "-q", "-b", "dev"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function readDump(dir) {
  const res = spawnSync("just", ["--dump", "--dump-format", "json"], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

function makeEnv(dir, tempDir, gatewayUrl, extra = {}) {
  return {
    PATH: process.env.PATH,
    PRIVATE_REPO: "true",
    GITHUB_EVENT_PATH: "",
    GITHUB_STEP_SUMMARY: "",
    GITHUB_OUTPUT: "",
    GITHUB_WORKSPACE: dir,
    RUNNER_TEMP: tempDir,
    RUNNER_ENVIRONMENT: "self-hosted",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    NDDEV_CI_RUNNER_PROFILE: "linux-x64",
    NDDEV_CI_SDK_LOCK_SHA256: "a".repeat(64),
    GITHUB_REPOSITORY: "owner/project",
    GITHUB_REPOSITORY_ID: "12345",
    GITHUB_SERVER_URL: "https://github.com",
    NDDEV_CI_ACTION_REF: wfSha,
    GITHUB_ACTION_REF: wfSha,
    NDDEV_CI_RECEIPT_GATEWAY: gatewayUrl,
    BASE_SHA: baseSha,
    HEAD_SHA: headSha,
    GITHUB_SHA: headSha,
    ...extra,
  };
}

function fakeJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function runPrMint(env, tempDir, changedFiles, runId = "55001") {
  const prEnv = {
    ...env,
    EVENT: "pull_request",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REF: "refs/pull/12/merge",
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: "1",
    RECEIPT_INPUTS: JSON.stringify({ "reuse-receipts": true, "cache-epoch": "1", "canary-percent": 0 }),
  };
  const planDoc = await checkPrepare(prEnv, { fetchChangedFiles: async () => changedFiles });
  writeFileSync(path.join(tempDir, "nddev-ci-receipt-results.txt"), planDoc.steps.map((_, i) => String(i)).join("\n") + "\n");
  await checkFinish({
    ...prEnv,
    RECEIPT_PLAN: path.join(tempDir, "nddev-ci-receipt-plan.json"),
    RECEIPT_RESULTS: path.join(tempDir, "nddev-ci-receipt-results.txt"),
  }, {
    fetchOidcToken: async () => ({
      token: fakeJwt({ event_name: "pull_request", repository: "owner/project", repository_id: "12345", job_workflow_sha: wfSha, run_id: runId }),
    }),
  });
  return planDoc;
}

async function startMockGateway({ workflowSha = wfSha, repository = "owner/project", repositoryId = "12345" } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const stored = new Map();
  const issued = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/.nddev/receipts/v1/public-key") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ key_id: "test-key", algorithm: "ed25519", public_key_pem: publicKeyPem }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/.nddev/receipts/v1/lookup") {
      const repoId = url.searchParams.get("repository_id");
      const digest = url.searchParams.get("input_digest");
      for (const scope of (url.searchParams.get("scopes") || "trusted,pr").split(",")) {
        const hit = stored.get(`${scope}:${repoId}:${digest}`);
        if (hit) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ envelope: hit, public_key_pem: publicKeyPem }));
          return;
        }
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/.nddev/receipts/v1/issue") {
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("Bearer ")) { res.writeHead(401); res.end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const jwtPayload = JSON.parse(Buffer.from(auth.slice(7).split(".")[1], "base64").toString("utf8"));
      const namespace = jwtPayload.event_name === "pull_request" ? "pr" : "trusted";
      const nowMs = Date.now();
      const statement = {
        schema: "nddev-ci.step-receipt.v1",
        namespace,
        repository: jwtPayload.repository || repository,
        repository_id: String(jwtPayload.repository_id || repositoryId),
        event_name: jwtPayload.event_name || "pull_request",
        ref: jwtPayload.ref || "refs/pull/1/merge",
        sha: jwtPayload.sha || headSha,
        run_id: String(body.run_id || jwtPayload.run_id || "9001"),
        run_attempt: Number(body.run_attempt || 1),
        run_url: String(body.run_url || `https://github.com/${repository}/actions/runs/9001`),
        job_workflow_sha: jwtPayload.job_workflow_sha || workflowSha,
        check_id: body.check_id, argv: body.argv, tree_sha: body.tree_sha, input_digest: body.input_digest,
        runner_digest: body.runner_digest, toolchain_digest: body.toolchain_digest, cache_epoch: body.cache_epoch,
        status: "success",
        issued_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };
      const envelope = signDsseEnvelope(statement, privateKeyPem, "test-key");
      const key = `${namespace}:${statement.repository_id}:${body.input_digest}`;
      stored.set(key, envelope);
      issued.push({ key, statement });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ envelope, namespace, key }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stored, issued, publicKeyPem, privateKeyPem,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("input digest changes on source, mode, lockfile, recipe, SDK, workflow SHA and CACHE_EPOCH", withJust, () => {
  const dir = makeRepo({
    justfile: "check:\n    echo ok\ntest:\n    echo test\nverify: check test\n",
    "Cargo.lock": "version = 4\n",
    "src/lib.rs": "pub fn a() {}\n",
    "scripts/run.sh": "#!/bin/sh\necho hi\n",
  });
  try {
    const baseEnv = {
      RUNNER_ENVIRONMENT: "self-hosted", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
      NDDEV_CI_RUNNER_PROFILE: "linux-x64", NDDEV_CI_SDK_LOCK_SHA256: "c".repeat(64),
      RUNNER_NAME: "slot-a", GITHUB_WORKSPACE: "/work/a",
    };
    const snap = (env = baseEnv, epoch = "1", wf = wfSha, sdk = {}) => {
      const tree = gitTreeState(dir);
      const { runnerDigest, toolchainDigest } = computeToolchainAndRunnerDigests(env, sdk);
      return computeInputDigest({
        cacheEpoch: epoch, workflowSha: wf, checkId: checkIdForArgv(["check"]),
        treeSha: tree.treeSha, lockfilesDigest: tree.lockfilesDigest,
        recipeDigest: recipeClosureDigest(readDump(dir), ["check"]), toolchainDigest, runnerDigest,
      });
    };
    const d0 = snap();
    assert.equal(d0, snap({ ...baseEnv, RUNNER_NAME: "slot-b", GITHUB_WORKSPACE: "/work/b" }));
    assert.notEqual(d0, snap(baseEnv, "2"));
    assert.notEqual(d0, snap(baseEnv, "1", otherWfSha));
    assert.notEqual(d0, snap({ ...baseEnv, NDDEV_CI_SDK_LOCK_SHA256: "d".repeat(64) }));
    assert.notEqual(d0, snap(baseEnv, "1", wfSha, { "rust-version": "1.100.0" }));

    chmodSync(path.join(dir, "scripts/run.sh"), 0o755);
    git(dir, ["add", "scripts/run.sh"]);
    git(dir, ["commit", "-q", "-m", "chmod"]);
    const dMode = snap();
    assert.notEqual(d0, dMode);

    writeFileSync(path.join(dir, "Cargo.lock"), "version = 4\n# bump\n");
    git(dir, ["add", "Cargo.lock"]);
    git(dir, ["commit", "-q", "-m", "lock"]);
    assert.notEqual(dMode, snap());

    writeFileSync(path.join(dir, "src/lib.rs"), "pub fn b() {}\n");
    assert.equal(gitTreeState(dir).dirty, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bypass rules catch workflows, justfiles, lockfiles, releases, artifacts, reports and missing diffs", () => {
  for (const [file, reason] of [
    [".github/workflows/ci.yml", "workflow-edit"],
    [".github/actions/custom/action.yml", "workflow-edit"],
    ["justfile", "justfile-edit"], ["web/justfile", "justfile-edit"], ["tools/checks.just", "justfile-edit"],
    ["Cargo.lock", "lockfile-edit"], ["web/bun.lock", "lockfile-edit"],
    ["config/sdk/linux-x64.lock.toml", "lockfile-edit"], ["config/harnesses.lock.json", "lockfile-edit"],
    ["src/main.rs", ""], ["README.md", ""],
  ]) assert.equal(classifyPathBypass(file), reason, file);

  assert.equal(isReleaseRef("refs/heads/main"), true);
  assert.equal(isReleaseRef("refs/tags/v1.0.0"), true);
  assert.equal(isReleaseRef("refs/heads/release/2.x"), true);
  assert.equal(isReleaseRef("refs/heads/dev"), false);

  const okBase = { reuse: true, ref: "refs/heads/dev", reports: "", dirty: false, workflowSha: wfSha, treeSha: headSha, changedFiles: ["src/lib.rs"] };
  assert.deepEqual(evaluateBypass(okBase), { bypass: false, reason: "" });
  assert.deepEqual(evaluateBypass({ ...okBase, changedFiles: [".github/workflows/ci.yml"] }), { bypass: true, reason: "workflow-edit" });
  assert.deepEqual(evaluateBypass({ ...okBase, changedFiles: ["justfile"] }), { bypass: true, reason: "justfile-edit" });
  assert.deepEqual(evaluateBypass({ ...okBase, changedFiles: ["uv.lock"] }), { bypass: true, reason: "lockfile-edit" });
  assert.deepEqual(evaluateBypass({ ...okBase, changedFiles: null }), { bypass: true, reason: "diff-unavailable" });
  assert.deepEqual(evaluateBypass({ ...okBase, ref: "refs/heads/main" }), { bypass: true, reason: "release-ref" });
  assert.deepEqual(evaluateBypass({ ...okBase, reports: "junit.xml" }), { bypass: true, reason: "reports-required" });
  assert.deepEqual(evaluateBypass({ ...okBase, dirty: true }), { bypass: true, reason: "dirty-worktree" });
  assert.deepEqual(evaluateBypass({ ...okBase, artifact: "dist", wholeJobArtifact: true }), { bypass: true, reason: "artifact-output" });

  assert.equal(isArtifactProducingPart({ label: "verify: build", group: "build", argv: ["build"] }), true);
  assert.equal(isArtifactProducingPart({ label: "verify: check", group: "check", argv: ["check"] }), false);
});

test("canary sampling is deterministic on dev push and off on pull requests", () => {
  assert.equal(selectCanary({ repository: "o/r", runId: "1", sha: headSha, percent: 100, eventName: "pull_request", ref: "refs/pull/1/merge" }).canary, false);
  assert.equal(selectCanary({ repository: "o/r", runId: "1", sha: headSha, percent: 0, eventName: "push", ref: "refs/heads/dev" }).canary, false);
  assert.equal(selectCanary({ repository: "o/r", runId: "1", sha: headSha, percent: 100, eventName: "push", ref: "refs/heads/dev" }).canary, true);
  let hits = 0;
  for (let i = 0; i < 400; i++) {
    if (selectCanary({ repository: "o/r", runId: String(i), sha: headSha, percent: 5, eventName: "push", ref: "refs/heads/dev" }).canary) hits++;
  }
  assert.ok(hits >= 5 && hits <= 45, `expected ~5% canary hits out of 400, got ${hits}`);
});

test("Ed25519 DSSE signature verification rejects tampering, wrong key, wrong tree, wrong workflow SHA, and expiry", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const { publicKey: otherPublicKey } = generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const otherPubPem = otherPublicKey.export({ type: "spki", format: "pem" }).toString();
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const nowMs = Date.parse("2026-11-24T12:00:00Z");
  const statement = {
    schema: "nddev-ci.step-receipt.v1", namespace: "pr", repository: "owner/project", repository_id: "42",
    event_name: "pull_request", ref: "refs/pull/7/merge", sha: headSha, run_id: "7001", run_attempt: 1,
    run_url: "https://github.com/owner/project/actions/runs/7001", job_workflow_sha: wfSha, check_id: "just:check",
    argv: ["check"], tree_sha: baseSha, input_digest: "e".repeat(64), runner_digest: "f".repeat(64),
    toolchain_digest: "9".repeat(64), cache_epoch: "1", status: "success",
    issued_at: new Date(nowMs - 60_000).toISOString(), expires_at: new Date(nowMs + 3_600_000).toISOString(),
  };
  const expected = {
    repository: "owner/project", repositoryId: "42", treeSha: baseSha, inputDigest: "e".repeat(64),
    workflowSha: wfSha, cacheEpoch: "1", checkId: "just:check", allowedNamespaces: ["trusted", "pr"],
  };

  const envelope = signDsseEnvelope(statement, privPem, "k1");
  assert.equal(verifySignedReceipt(envelope, pubPem, expected, nowMs).valid, true);
  assert.equal(verifySignedReceipt(envelope, otherPubPem, expected, nowMs).reason, "invalid-signature");
  assert.equal(verifySignedReceipt({ ...envelope, payload: Buffer.from(JSON.stringify({ ...statement, status: "failure" })).toString("base64") }, pubPem, expected, nowMs).reason, "invalid-signature");
  assert.equal(verifySignedReceipt(envelope, pubPem, { ...expected, treeSha: headSha }, nowMs).reason, "tree-mismatch");
  assert.equal(verifySignedReceipt(envelope, pubPem, { ...expected, workflowSha: otherWfSha }, nowMs).reason, "workflow-sha-mismatch");
  assert.equal(verifySignedReceipt(envelope, pubPem, { ...expected, cacheEpoch: "2" }, nowMs).reason, "epoch-mismatch");
  assert.equal(verifySignedReceipt(envelope, pubPem, { ...expected, allowedNamespaces: ["trusted"] }, nowMs).reason, "namespace-disallowed");
  assert.equal(verifySignedReceipt(envelope, pubPem, expected, nowMs + 4_000_000).reason, "expired");
});

test("sanitizeProjectEnv removes GitHub OIDC request credentials before project commands run", () => {
  const clean = sanitizeProjectEnv({
    PATH: "/usr/bin", ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/oidc",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret-bearer", NDDEV_CI_RECEIPT_TOKEN: "secret-receipt",
  });
  assert.deepEqual(clean, { PATH: "/usr/bin" });
});

test("PR receipts are reused by dev plan so only uncached parts run, and cross-arch plan fails closed", withJust, async () => {
  const dir = makeRepo({
    justfile: "check:\n    echo check\ntest:\n    echo test\nbuild:\n    echo build\nverify: check test build\n",
    "src/app.rs": "fn main() {}\n",
  });
  const gateway = await startMockGateway();
  const tempDir = mkdtempSync(path.join(tmpdir(), "step-receipts-tmp-"));
  try {
    const commonEnv = makeEnv(dir, tempDir, gateway.url);
    const prPlan = await runPrMint(commonEnv, tempDir, ["src/app.rs"], "55001");
    assert.equal(prPlan.steps.length, 2);
    assert.equal(gateway.issued.length, 2);

    const planSummary = path.join(tempDir, "plan-summary");
    writeFileSync(planSummary, "");
    const fullMatrix = [
      { label: "verify: check", task: "verify: check", group: "check", argv: ["check"] },
      { label: "verify: test", task: "verify: test", group: "test", argv: ["test"] },
      { label: "verify: build", task: "verify: build", group: "build", argv: ["build"] },
    ];
    const receiptInputs = JSON.stringify({ "reuse-receipts": true, "cache-epoch": "1", "canary-percent": 0, runner: "nddev-linux-standart" });
    const planResult = await stepReceiptMain({
      ...commonEnv, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/dev", GITHUB_RUN_ID: "55002",
      GITHUB_STEP_SUMMARY: planSummary, INPUT_MODE: "plan", INPUT_MATRIX: JSON.stringify(fullMatrix),
      INPUT_SPLIT: "true", "INPUT_RECEIPT-INPUTS": receiptInputs,
    }, { fetchChangedFiles: async () => ["src/app.rs"] });

    assert.deepEqual(planResult.matrix.map((p) => p.label), ["verify: build"]);
    assert.equal(planResult.allReused, false);
    assert.equal(planResult.reused.length, 2);
    assert.equal(planResult.reused[0].reusedRunId, "55001");
    assert.match(readFileSync(planSummary, "utf8"), /#55001/);

    const allResult = await stepReceiptMain({
      ...commonEnv, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/dev", GITHUB_RUN_ID: "55003",
      INPUT_MODE: "plan", INPUT_MATRIX: JSON.stringify(fullMatrix.slice(0, 2)),
      INPUT_SPLIT: "true", "INPUT_RECEIPT-INPUTS": receiptInputs,
    }, { fetchChangedFiles: async () => ["src/app.rs"] });
    assert.deepEqual(allResult.matrix, []);
    assert.equal(allResult.allReused, true);

    const joinSummary = path.join(tempDir, "join-summary");
    writeFileSync(joinSummary, "");
    const summaryResult = await stepReceiptMain({
      GITHUB_STEP_SUMMARY: joinSummary, INPUT_MODE: "summary", INPUT_REUSED: JSON.stringify(allResult.reused),
    });
    assert.equal(summaryResult.mode, "reused");
    assert.equal(summaryResult.reusedRunId, "55001");
    assert.match(readFileSync(joinSummary, "utf8"), /https:\/\/github\.com\/owner\/project\/actions\/runs\/55001/);

    const armTarget = targetRunnerForPart({ privateRepo: true, runner: "nddev-linux-standart" });
    assert.equal(planMatchesTarget({ ...commonEnv, RUNNER_ARCH: "ARM64", NDDEV_CI_RUNNER_PROFILE: "linux-arm64" }, armTarget), false);
    const armResult = await stepReceiptMain({
      ...commonEnv, RUNNER_ARCH: "ARM64", NDDEV_CI_RUNNER_PROFILE: "linux-arm64",
      GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/dev", GITHUB_RUN_ID: "55004",
      INPUT_MODE: "plan", INPUT_MATRIX: JSON.stringify(fullMatrix.slice(0, 2)),
      INPUT_SPLIT: "true", "INPUT_RECEIPT-INPUTS": receiptInputs,
    }, { fetchChangedFiles: async () => ["src/app.rs"] });
    assert.equal(armResult.matrix.length, 2);
    assert.equal(armResult.allReused, false);

    // Cross-arch plan omits verified X64 parts when gateway exposes matching live linux-x64 runner-info.
    const justVer = spawnSync("just", ["--version"], { encoding: "utf8" }).stdout.trim();
    const armWithInfo = await stepReceiptMain({
      ...commonEnv, RUNNER_ARCH: "ARM64", NDDEV_CI_RUNNER_PROFILE: "linux-arm64",
      NDDEV_CI_SDK_LOCK_SHA256: "2".repeat(64),
      GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/dev", GITHUB_RUN_ID: "55005",
      INPUT_MODE: "plan", INPUT_MATRIX: JSON.stringify(fullMatrix.slice(0, 2)),
      INPUT_SPLIT: "true", "INPUT_RECEIPT-INPUTS": receiptInputs,
    }, {
      fetchChangedFiles: async () => ["src/app.rs"],
      fetchGatewayRunnerInfo: async ({ profile }) => profile === "linux-x64" ? {
        environment: "self-hosted", os: "Linux", arch: "X64", profile: "linux-x64",
        sdkLockSha256: commonEnv.NDDEV_CI_SDK_LOCK_SHA256, justVersion: justVer,
      } : null,
    });
    assert.equal(armWithInfo.allReused, true);
    assert.equal(armWithInfo.reused.length, 2);
    assert.equal(armWithInfo.matrix.length, 0);
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("unsplit verify with a body skips PR-verified prior deps and runs only build + body, and canary detects mismatch", withJust, async () => {
  const dir = makeRepo({
    justfile: "check:\n    echo check\ntest:\n    echo test\nbuild:\n    echo build\nverify: check test build\n    echo e2e\n",
    "src/web.ts": "export const x = 1;\n",
  });
  const gateway = await startMockGateway();
  const tempDir = mkdtempSync(path.join(tmpdir(), "step-receipts-body-"));
  try {
    const decomp = inspectVerifyDecomposition(readDump(dir));
    assert.equal(decomp.canDecompose, true);
    assert.deepEqual(decomp.priors.map((p) => p.argv), [["check"], ["test"], ["build"]]);
    assert.equal(decomp.hasBody, true);

    const commonEnv = makeEnv(dir, tempDir, gateway.url);
    await runPrMint(commonEnv, tempDir, ["src/web.ts"], "88001");

    const devPlan = await checkPrepare({
      ...commonEnv, EVENT: "push", GITHUB_REF: "refs/heads/dev", GITHUB_RUN_ID: "88002", PART: "[\"verify\"]",
      RECEIPT_INPUTS: JSON.stringify({ "reuse-receipts": true, "cache-epoch": "1", "canary-percent": 0 }),
    }, { fetchChangedFiles: async () => ["src/web.ts"] });
    assert.deepEqual(devPlan.steps.map((s) => [s.argv.join(" "), s.skip]), [
      ["check", true], ["test", true], ["build", false], ["--no-deps verify", false],
    ]);

    const canaryPlan = await checkPrepare({
      ...commonEnv, EVENT: "push", GITHUB_REF: "refs/heads/dev", GITHUB_RUN_ID: "88003", PART: "[\"check\"]",
      RECEIPT_INPUTS: JSON.stringify({ "reuse-receipts": true, "cache-epoch": "1", "canary-percent": 100 }),
    }, { fetchChangedFiles: async () => ["src/web.ts"] });
    assert.equal(canaryPlan.canary, true);
    assert.equal(canaryPlan.steps[0].skip, false);
    assert.equal(canaryPlan.steps[0].cachedHit, true);

    writeFileSync(path.join(tempDir, "nddev-ci-receipt-results.txt"), "failed:0:1\n");
    const canaryFinish = await checkFinish({
      ...commonEnv,
      RECEIPT_PLAN: path.join(tempDir, "nddev-ci-receipt-plan.json"),
      RECEIPT_RESULTS: path.join(tempDir, "nddev-ci-receipt-results.txt"),
      RUNNER_REASON: "",
    });
    assert.equal(canaryFinish.stats.mode, "canary");
    assert.equal(canaryFinish.stats.canaryResult, "mismatch");
    assert.equal(canaryFinish.stats.reusedRunId, "88001");
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("public hosted receipts use GitHub cache files and block PR receipts on dev push", withJust, async () => {
  const dir = makeRepo({ justfile: "check:\n    echo check\nverify: check\n", "README.md": "hello\n" });
  const tempDir = mkdtempSync(path.join(tmpdir(), "step-receipts-pub-"));
  try {
    const planDoc = await checkPrepare({
      GITHUB_WORKSPACE: dir, RUNNER_TEMP: tempDir, RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Linux", RUNNER_ARCH: "X64", ImageOS: "ubuntu24", ImageVersion: "20261124.1",
      PRIVATE_REPO: "false", GITHUB_REPOSITORY: "owner/public-repo", GITHUB_REPOSITORY_ID: "99",
      GITHUB_SERVER_URL: "https://github.com", NDDEV_CI_ACTION_REF: wfSha,
      BASE_SHA: baseSha, HEAD_SHA: headSha, EVENT: "push", GITHUB_REF: "refs/heads/dev",
      GITHUB_RUN_ID: "30001", PART: "[\"check\"]",
      RECEIPT_INPUTS: JSON.stringify({ "reuse-receipts": true, "cache-epoch": "1", "canary-percent": 0 }),
    }, { fetchChangedFiles: async () => ["README.md"] });

    mkdirSync(planDoc.publicCacheDir, { recursive: true });
    const step = planDoc.steps[0];
    const prStatement = buildPublicReceiptStatement({
      ...planDoc, eventName: "pull_request", ref: "refs/pull/5/merge", runId: "29999",
      runUrl: "https://github.com/owner/public-repo/actions/runs/29999",
      checkId: step.checkId, argv: step.argv, inputDigest: step.inputDigest,
    });
    writeFileSync(path.join(planDoc.publicCacheDir, `${step.inputDigest}.json`), JSON.stringify(prStatement));
    assert.equal(resolvePublic({ RECEIPT_PLAN: path.join(tempDir, "nddev-ci-receipt-plan.json") }).steps[0].skip, false);

    const devStatement = { ...prStatement, namespace: "trusted", event_name: "push", ref: "refs/heads/dev", run_id: "30000" };
    writeFileSync(path.join(planDoc.publicCacheDir, `${step.inputDigest}.json`), JSON.stringify(devStatement));
    const afterDev = resolvePublic({ RECEIPT_PLAN: path.join(tempDir, "nddev-ci-receipt-plan.json") });
    assert.equal(afterDev.steps[0].skip, true);
    assert.equal(afterDev.steps[0].reusedRunId, "30000");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("project-check bash dispatch skips reused steps, strips OIDC env, and runs only uncached steps", withJust, () => {
  const dir = makeRepo({
    justfile: "check:\n    @echo check >> events\n    @test -z \"${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}\"\ntest:\n    @echo test >> events\nbuild:\n    @echo build >> events\nverify: check test build\n    @echo e2e >> events\n",
  });
  const tempDir = mkdtempSync(path.join(tmpdir(), "step-receipts-bash-"));
  try {
    const planFile = path.join(tempDir, "plan.json");
    const resultsFile = path.join(tempDir, "results.txt");
    writeFileSync(resultsFile, "");
    writeFileSync(planFile, JSON.stringify({
      all_skipped: false,
      steps: [
        { argv: ["check"], skip: true, reusedRunId: "99001", reusedRunUrl: "https://github.com/o/r/actions/runs/99001" },
        { argv: ["test"], skip: true, reusedRunId: "99001", reusedRunUrl: "https://github.com/o/r/actions/runs/99001" },
        { argv: ["build"], skip: false },
        { argv: ["--no-deps", "verify"], skip: false },
      ],
    }));
    const script = readFileSync("actions/project-check/action.yml", "utf8")
      .split("# recipe-dispatch:begin")[1].split("# recipe-dispatch:end")[0]
      .split("\n").map((l) => (l.startsWith("        ") ? l.slice(8) : l)).join("\n");
    const res = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: dir, encoding: "utf8",
      env: {
        ...process.env, EVENT: "push", SETUP: "false", PART: "[\"verify\"]", RUNNER_ENVIRONMENT: "github-hosted",
        PROJECT_COMMAND: path.resolve("lib/project-command.mjs"), RECEIPT_PLAN: planFile, RECEIPT_RESULTS: resultsFile,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "should-be-stripped", ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/x",
      },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(readFileSync(path.join(dir, "events"), "utf8").trim().split("\n"), ["build", "e2e"]);
    assert.match(res.stdout, /Reused step receipt for `just check` from run #99001/);
    assert.deepEqual(readFileSync(resultsFile, "utf8").trim().split("\n"), ["2", "3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("actions/recipe reuses verified gateway receipt and skips re-running the recipe", withJust, async () => {
  const dir = makeRepo({
    justfile: "lint:\n    @echo lint >> ran\n    @test -z \"${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}\"\n",
    "src/a.txt": "hello\n",
  });
  const gateway = await startMockGateway();
  const tempDir = mkdtempSync(path.join(tmpdir(), "step-receipts-recipe-"));
  const justVersion = spawnSync("just", ["--version"], { encoding: "utf8" }).stdout.trim().replace(/^just /, "");
  const pinnedJust = JSON.parse(readFileSync("actions/recipe/just.json", "utf8")).version;
  try {
    if (justVersion !== pinnedJust) return;
    const baseEnv = {
      ...process.env, ...makeEnv(dir, tempDir, gateway.url),
      INPUT_MANAGED: "true", INPUT_RECIPE: "lint", INPUT_ARGUMENTS: "[]",
      "INPUT_WORKING-DIRECTORY": ".", INPUT_JUSTFILE: "justfile",
      "INPUT_RECEIPT-INPUTS": JSON.stringify({ "reuse-receipts": true, "cache-epoch": "1", "canary-percent": 0 }),
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-leak-to-just",
    };
    await recipeMain({ ...baseEnv, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/8/merge", GITHUB_RUN_ID: "66001" }, {
      fetchChangedFiles: async () => ["src/a.txt"],
      fetchOidcToken: async () => ({
        token: fakeJwt({ event_name: "pull_request", repository: "owner/project", repository_id: "12345", job_workflow_sha: wfSha, run_id: "66001" }),
      }),
    });
    assert.equal(readFileSync(path.join(dir, "ran"), "utf8").trim(), "lint");
    assert.equal(gateway.issued.length, 1);

    const out2 = path.join(tempDir, "out2");
    const sum2 = path.join(tempDir, "sum2");
    writeFileSync(out2, "");
    writeFileSync(sum2, "");
    await recipeMain({
      ...baseEnv, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/dev", GITHUB_RUN_ID: "66002",
      GITHUB_OUTPUT: out2, GITHUB_STEP_SUMMARY: sum2,
    }, { fetchChangedFiles: async () => ["src/a.txt"] });
    assert.equal(readFileSync(path.join(dir, "ran"), "utf8").trim(), "lint");
    assert.match(readFileSync(out2, "utf8"), /receipt-mode=reused/);
    assert.match(readFileSync(out2, "utf8"), /reused-run-id=66001/);
    assert.match(readFileSync(sum2, "utf8"), /#66001/);
  } finally {
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("job-record validates and records step receipt fields and summary", () => {
  const doc = record({
    INPUT_TASK: "verify: check", "INPUT_TASK-TYPE": "test", INPUT_STATUS: "success",
    "INPUT_RECEIPT-MODE": "reused", "INPUT_REUSED-RUN-ID": "55001", "INPUT_CANARY-RESULT": "match",
    GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "owner/project", GITHUB_WORKFLOW: "ci",
    GITHUB_RUN_ID: "55002", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "check", GITHUB_SHA: headSha,
    GITHUB_REF_NAME: "dev", GITHUB_EVENT_NAME: "push", RUNNER_NAME: "slot01",
    RUNNER_ENVIRONMENT: "self-hosted", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
  });
  assert.equal(doc["nddev_ci.receipt.mode"], "reused");
  assert.equal(doc["nddev_ci.receipt.reused_run_id"], "55001");
  assert.equal(doc["nddev_ci.receipt.canary_result"], "match");
  assert.throws(() => record({ INPUT_TASK: "check", INPUT_STATUS: "success", "INPUT_RECEIPT-MODE": "bogus" }), /receipt-mode/);
  const md = formatReceiptSummary([{
    label: "verify: check", outcome: "reused (pass)", reusedRunId: "55001",
    reusedRunUrl: "https://github.com/owner/project/actions/runs/55001",
    reusedEvent: "pull_request", treeSha: baseSha, inputDigest: "e".repeat(64),
  }]);
  assert.match(md, /\[#55001\]\(https:\/\/github\.com\/owner\/project\/actions\/runs\/55001\)/);

  const metaDir = mkdtempSync(path.join(tmpdir(), "nddev-receipt-meta-"));
  try {
    const startedFile = path.join(metaDir, "nddev-ci-started");
    writeFileSync(startedFile, String(Math.floor(Date.now() / 1000) - 5));
    writeFileSync(path.join(metaDir, "nddev-ci-receipt.json"), JSON.stringify({ mode: "reused", reused_run_id: "55003" }));
    const fromMeta = record({
      INPUT_TASK: "full check", "INPUT_TASK-TYPE": "test", INPUT_STATUS: "success",
      "INPUT_STARTED-FILE": startedFile,
      GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "owner/project", GITHUB_WORKFLOW: "ci",
      GITHUB_RUN_ID: "55004", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "full-check", GITHUB_SHA: headSha,
      GITHUB_REF_NAME: "dev", GITHUB_EVENT_NAME: "push", RUNNER_NAME: "slot01",
      RUNNER_ENVIRONMENT: "self-hosted", RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
    });
    assert.equal(fromMeta["nddev_ci.receipt.mode"], "reused");
    assert.equal(fromMeta["nddev_ci.receipt.reused_run_id"], "55003");
  } finally {
    rmSync(metaDir, { recursive: true, force: true });
  }
});
