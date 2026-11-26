import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { finish as checkFinish, prepare as checkPrepare } from "../actions/project-check/receipts.mjs";
import { runSteps } from "../actions/project-check/run-steps.mjs";
import { matchesPrefix, parsePartPaths, selectActiveParts } from "../lib/part-paths.mjs";

const hasJust = spawnSync("just", ["--version"], { encoding: "utf8" }).status === 0;
const withJust = hasJust ? {} : { skip: "just is not installed" };

const sampleParts = [
  { label: "check", group: "check", argv: ["check"] },
  { label: "api-test", group: "api", argv: ["api-test"] },
  { label: "web-test", group: "web", argv: ["web-test"] },
  { label: "build", group: "build", argv: ["build"] },
];

const samplePaths = {
  api: ["services/api/", "crates/shared"],
  web: ["apps/web"],
  build: ["services/api", "apps/web"],
};

test("parsePartPaths validates JSON object shape and rejects unsafe prefixes", () => {
  assert.deepEqual(parsePartPaths(""), {});
  assert.deepEqual(parsePartPaths("{}"), {});
  assert.deepEqual(parsePartPaths(JSON.stringify(samplePaths)), {
    api: ["services/api", "crates/shared"],
    web: ["apps/web"],
    build: ["services/api", "apps/web"],
  });
  assert.throws(() => parsePartPaths("not json"), /valid JSON/);
  assert.throws(() => parsePartPaths("[]"), /JSON object/);
  assert.throws(() => parsePartPaths('{"api":[]}'), /non-empty array/);
  assert.throws(() => parsePartPaths('{"api":["/abs"]}'), /plain repository-relative/);
  assert.throws(() => parsePartPaths('{"api":["../escape"]}'), /plain repository-relative/);
  assert.throws(() => parsePartPaths('{"api":["services/*"]}'), /plain repository-relative/);
});

test("matchesPrefix checks exact file or directory boundaries without sibling collisions", () => {
  assert.equal(matchesPrefix("crates/foo/src/lib.rs", "crates/foo"), true);
  assert.equal(matchesPrefix("crates/foo", "crates/foo"), true);
  assert.equal(matchesPrefix("./crates/foo/a.rs", "crates/foo/"), true);
  assert.equal(matchesPrefix("crates/foobar/src/lib.rs", "crates/foo"), false);
  assert.equal(matchesPrefix("README.md", "."), true);
});

test("selectActiveParts filters untouched mapped parts while keeping unmapped parts and failing safe", () => {
  // Only web changed: check (unmapped) + web + build stay active; api is skipped.
  const webOnly = selectActiveParts({
    parts: sampleParts,
    changedFiles: ["apps/web/src/index.ts"],
    partPaths: samplePaths,
    ref: "refs/heads/dev",
  });
  assert.equal(webOnly.reason, "filtered");
  assert.deepEqual(webOnly.activeParts.map((p) => p.group), ["check", "web", "build"]);
  assert.deepEqual(webOnly.skippedParts.map((p) => p.group), ["api"]);

  // Any unmapped file falls back to running every part.
  const unmapped = selectActiveParts({
    parts: sampleParts,
    changedFiles: ["apps/web/src/index.ts", "scripts/deploy.sh"],
    partPaths: samplePaths,
    ref: "refs/heads/dev",
  });
  assert.equal(unmapped.reason, "unmapped-file");
  assert.equal(unmapped.skippedParts.length, 0);
  assert.equal(unmapped.activeParts.length, sampleParts.length);

  // Global/workflow/justfile/lockfile edits fall back to running every part.
  for (const file of [".github/workflows/ci.yml", "justfile", "Cargo.lock", "Cargo.toml", "apps/web/package-lock.json"]) {
    const globalRes = selectActiveParts({
      parts: sampleParts,
      changedFiles: [file],
      partPaths: samplePaths,
      ref: "refs/heads/dev",
    });
    assert.equal(globalRes.reason, "global-change", file);
    assert.equal(globalRes.skippedParts.length, 0);
  }

  // Release refs and unavailable diffs always run every part.
  for (const ref of ["refs/heads/main", "refs/tags/v1.0.0", "refs/heads/release/2"]) {
    const rel = selectActiveParts({
      parts: sampleParts,
      changedFiles: ["apps/web/src/index.ts"],
      partPaths: samplePaths,
      ref,
    });
    assert.equal(rel.reason, "release-ref", ref);
    assert.equal(rel.skippedParts.length, 0);
  }
  const missingDiff = selectActiveParts({
    parts: sampleParts,
    changedFiles: null,
    partPaths: samplePaths,
    ref: "refs/heads/dev",
  });
  assert.equal(missingDiff.reason, "diff-unavailable");
  assert.equal(missingDiff.skippedParts.length, 0);

  // Artifact-producing part is never skipped when artifact output is configured.
  const withArtifact = selectActiveParts({
    parts: sampleParts,
    changedFiles: ["services/api/src/main.rs"],
    partPaths: { api: ["services/api"], web: ["apps/web"], build: ["apps/web"] },
    ref: "refs/heads/dev",
    artifact: "dist/app",
  });
  assert.deepEqual(withArtifact.activeParts.map((p) => p.group), ["check", "api", "build"]);
  assert.deepEqual(withArtifact.skippedParts.map((p) => p.group), ["web"]);
});

test("single-job project-check honors part-paths without misreporting filtered parts as receipt reuse", withJust, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "part-paths-repo-"));
  const tempDir = mkdtempSync(path.join(tmpdir(), "part-paths-temp-"));
  try {
    writeFileSync(path.join(dir, "justfile"), [
      "check:",
      "    @echo check >> ran.log",
      "api:",
      "    @echo api >> ran.log",
      "web:",
      "    @echo web >> ran.log",
      "verify: check api web",
      "",
    ].join("\n"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

    const outFile = path.join(tempDir, "out");
    const sumFile = path.join(tempDir, "summary.md");
    writeFileSync(outFile, "");
    writeFileSync(sumFile, "");
    const env = {
      ...process.env,
      GITHUB_WORKSPACE: dir,
      RUNNER_TEMP: tempDir,
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
      EVENT: "push",
      SETUP: "false",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/dev",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "42001",
      GITHUB_OUTPUT: outFile,
      GITHUB_STEP_SUMMARY: sumFile,
      NDDEV_CI_ACTION_REF: "a".repeat(40),
      PART: '["verify"]',
      RECEIPT_INPUTS: JSON.stringify({
        "reuse-receipts": false,
        "part-paths": JSON.stringify({ api: ["services/api"], web: ["apps/web"] }),
      }),
    };

    const planDoc = await checkPrepare(env, { fetchChangedFiles: async () => ["apps/web/app.ts"] });
    assert.deepEqual(
      planDoc.steps.map((s) => [s.group, s.skip, Boolean(s.filteredByPath)]),
      [
        ["check", false, false],
        ["api", true, true],
        ["web", false, false],
      ],
    );

    const runEnv = {
      ...env,
      RECEIPT_PLAN: path.join(tempDir, "nddev-ci-receipt-plan.json"),
      RECEIPT_RESULTS: path.join(tempDir, "nddev-ci-receipt-results.txt"),
    };
    const code = await runSteps(runEnv, dir);
    assert.equal(code, 0);
    assert.deepEqual(readFileSync(path.join(dir, "ran.log"), "utf8").trim().split("\n"), ["check", "web"]);

    const finished = await checkFinish(runEnv);
    assert.equal(finished.stats.mode, "bypassed");
    assert.equal(finished.stats.reusedCount, 0);
    assert.match(readFileSync(sumFile, "utf8"), /skipped \(path filter\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
});
