import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_DURATION_SECONDS, MAX_FUTURE_SKEW_SECONDS, main, record, sccache } from "../actions/job-record/run.mjs";
import { runProjectCommand, runnerFailureClassifier, upstreamFailureClassifier } from "../lib/project-command.mjs";

const base = {
  INPUT_TASK: "short check",
  INPUT_STATUS: "success",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "owner/project",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_WORKFLOW: "ci",
  GITHUB_JOB: "check",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_REF_NAME: "dev",
  GITHUB_EVENT_NAME: "push",
  RUNNER_NAME: "jit01",
  RUNNER_ENVIRONMENT: "self-hosted",
  RUNNER_OS: "Linux",
  RUNNER_ARCH: "X64",
};

test("the record uses OpenTelemetry CI/CD and VCS names and maps the job status", () => {
  const document = record(base, new Date("2026-11-09T12:00:00Z"));
  assert.equal(document["event.name"], "nddev_ci.job.completed");
  assert.equal(document.severity, "INFO");
  assert.equal(document["cicd.pipeline.task.run.result"], "success");
  assert.equal(document["cicd.pipeline.run.url.full"], "https://github.com/owner/project/actions/runs/42");
  assert.equal(document["vcs.ref.head.revision"], "a".repeat(40));
  assert.equal(document["os.type"], "linux");
  assert.equal(document["host.arch"], "amd64");
  assert.equal(record({ ...base, INPUT_STATUS: "failure" })["severity"], "ERROR");
  assert.equal(record({ ...base, INPUT_STATUS: "cancelled" })["cicd.pipeline.task.run.result"], "cancellation");
  for (const status of ["", "skipped", "SUCCESS"])
    assert.throws(() => record({ ...base, INPUT_STATUS: status }), /status/);
  assert.throws(() => record({ ...base, INPUT_TASK: "x\ny" }), /task/);
  assert.throws(() => record({ ...base, "INPUT_TASK-TYPE": "lint" }), /task-type/);
});

test("the job's numeric GitHub ID joins the record to its job, beside the job's key", () => {
  const document = record({ ...base, "INPUT_CHECK-RUN-ID": "61234567890" });
  assert.equal(document["nddev_ci.job.check_run_id"], "61234567890");
  assert.equal(document["cicd.pipeline.task.run.id"], "check");
  assert.equal(Object.hasOwn(record(base), "nddev_ci.job.check_run_id"), false);
  for (const id of ["0", "12a", "-1", "1".repeat(17)])
    assert.throws(() => record({ ...base, "INPUT_CHECK-RUN-ID": id }), /check-run-id/);
});

test("duration comes from the start file and compiler-cache counters from sccache", () => {
  const root = mkdtempSync(path.join(tmpdir(), "job-record-"));
  try {
    writeFileSync(path.join(root, "started"), `${Date.parse("2026-11-09T11:58:30Z") / 1000}\n`);
    const document = record({ ...base, "INPUT_STARTED-FILE": path.join(root, "started") }, new Date("2026-11-09T12:00:00Z"));
    assert.equal(document["nddev_ci.duration_seconds"], 90);
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.deepEqual(
    sccache("Compile requests                    120\nCache hits                          100\nCache misses 20\nCache hits rate 83.33 %\n"),
    { requests: 120, hits: 100, misses: 20 },
  );
});

test("shared host compiler daemons omit aggregate sccache stats while per-slot wrappers keep them", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "job-record-sccache-"));
  try {
    const marker = path.join(root, "invoked");
    const wrapper = path.join(root, "sccache");
    writeFileSync(wrapper, `#!/bin/sh\necho called > "${marker}"\nprintf 'Compile requests 12\\nCache hits 10\\nCache misses 2\\n'\n`);
    chmodSync(wrapper, 0o755);

    const perSlot = record({ ...base, RUSTC_WRAPPER: wrapper });
    assert.equal(perSlot["nddev_ci.sccache.requests"], 12);
    assert.equal(perSlot["nddev_ci.sccache.hits"], 10);
    assert.equal(perSlot["nddev_ci.sccache.misses"], 2);
    assert.equal(existsSync(marker), true);

    rmSync(marker);
    const disabledFlag = record({ ...base, RUSTC_WRAPPER: wrapper, SCCACHE_CLIENT_SIDE: "0" });
    assert.equal(disabledFlag["nddev_ci.sccache.requests"], 12);
    assert.equal(existsSync(marker), true);

    for (const value of ["1", "true"]) {
      rmSync(marker, { force: true });
      const shared = record({ ...base, RUSTC_WRAPPER: wrapper, SCCACHE_CLIENT_SIDE: value });
      assert.equal(Object.keys(shared).some((key) => key.startsWith("nddev_ci.sccache.")), false);
      assert.equal(existsSync(marker), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native ARM64 records identify the actual OS and measured queue time", () => {
  for (const [system, expected] of [["macOS", "darwin"], ["Linux", "linux"]]) {
    const document = record({...base, RUNNER_OS: system, RUNNER_ARCH: "ARM64", NDDEV_CI_QUEUE_SECONDS: "1.25"});
    assert.equal(document["os.type"], expected);
    assert.equal(document["host.arch"], "arm64");
    assert.equal(document["nddev_ci.queue_seconds"], 1.25);
  }
  assert.equal(record(base)["nddev_ci.queue_seconds"], undefined);
  assert.equal(record({...base, NDDEV_CI_QUEUE_SECONDS: "0"})["nddev_ci.queue_seconds"], 0);
  for (const value of ["-1", "NaN", "Infinity", "1\nOTHER=value"])
    assert.throws(() => record({...base, NDDEV_CI_QUEUE_SECONDS: value}), /NDDEV_CI_QUEUE_SECONDS/);
});

test("the record reaches the runner's telemetry file only by an absolute regular path", () => {
  const root = mkdtempSync(path.join(tmpdir(), "job-record-sink-"));
  const quiet = { log: () => {} };
  try {
    const sink = path.join(root, "ci.jsonl");
    main({ ...base, NDDEV_CI_TELEMETRY_FILE: sink, GITHUB_STEP_SUMMARY: path.join(root, "summary.md") }, quiet);
    main({ ...base, INPUT_STATUS: "failure", NDDEV_CI_TELEMETRY_FILE: sink }, quiet);
    const lines = readFileSync(sink, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line["cicd.pipeline.task.run.result"]), ["success", "failure"]);
    assert.match(readFileSync(path.join(root, "summary.md"), "utf8"), /short check: success/);
    assert.throws(() => main({ ...base, NDDEV_CI_TELEMETRY_FILE: "relative.jsonl" }, quiet), /absolute path/);
    assert.throws(() => main({ ...base, NDDEV_CI_TELEMETRY_FILE: root }, quiet), /regular file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed job names its failure layer and always records a bounded failure reason", () => {
  const failed = { ...base, INPUT_STATUS: "failure" };
  const projectFailed = record({ ...failed, "INPUT_FAILURE-LAYER": "project" });
  assert.equal(projectFailed["nddev_ci.failure.layer"], "project");
  assert.equal(projectFailed["nddev_ci.failure.reason"], "project-failure");
  const libraryFailed = record({ ...failed, "INPUT_FAILURE-LAYER": "library" });
  assert.equal(libraryFailed["nddev_ci.failure.layer"], "library");
  assert.equal(libraryFailed["nddev_ci.failure.reason"], "library-failure");
  const unlayeredFailed = record(failed);
  assert.equal(unlayeredFailed["nddev_ci.failure.layer"], undefined);
  assert.equal(unlayeredFailed["nddev_ci.failure.reason"], "job-failure");
  const explicit = record({
    ...failed,
    "INPUT_FAILURE-LAYER": "library",
    "INPUT_FAILURE-REASON": "artifact-too-many-files",
  });
  assert.equal(explicit["nddev_ci.failure.layer"], "library");
  assert.equal(explicit["nddev_ci.failure.reason"], "artifact-too-many-files");
  assert.equal(
    record({ ...base, "INPUT_FAILURE-LAYER": "library", "INPUT_FAILURE-REASON": "artifact-too-many-files" })[
      "nddev_ci.failure.reason"
    ],
    undefined,
  );
  assert.equal(record({ ...base, "INPUT_FAILURE-LAYER": "library" })["nddev_ci.failure.layer"], undefined);
  assert.throws(() => record({ ...failed, "INPUT_FAILURE-LAYER": "runner" }), /failure-layer/);
  for (const invalid of ["Has Spaces", "UPPER", "line\nbreak", "a".repeat(65)])
    assert.throws(() => record({ ...failed, "INPUT_FAILURE-REASON": invalid }), /failure-reason/);
});

test("a fixed runner reason overrides layer and reason only for a failed job", () => {
  const source = {
    "INPUT_FAILURE-LAYER": "project",
    "INPUT_FAILURE-REASON": "project-command-failed",
    "INPUT_RUNNER-REASON": "docker-timeout",
  };
  const failed = record({ ...base, ...source, INPUT_STATUS: "failure" });
  assert.equal(failed["cicd.pipeline.task.run.result"], "failure");
  assert.equal(failed["nddev_ci.failure.layer"], "runner");
  assert.equal(failed["nddev_ci.failure.reason"], "docker-timeout");
  assert.equal(record({ ...base, INPUT_STATUS: "failure", "INPUT_FAILURE-LAYER": "library",
    "INPUT_RUNNER-REASON": "docker-unavailable" })["nddev_ci.failure.layer"], "runner");
  assert.equal(record({ ...base, INPUT_STATUS: "failure", "INPUT_RUNNER-REASON": "disk-quota-exceeded" })[
    "nddev_ci.failure.layer"
  ], "runner");
  for (const change of [source, { ...source, INPUT_STATUS: "cancelled" }])
    assert.equal(record({ ...base, ...change })["nddev_ci.failure.reason"], undefined);
  const unknownRunner = record({ ...base, ...source, INPUT_STATUS: "failure", "INPUT_RUNNER-REASON": "unknown" });
  assert.equal(unknownRunner["nddev_ci.failure.layer"], "project");
  assert.equal(unknownRunner["nddev_ci.failure.reason"], "project-command-failed");
});

test("runner attribution requires an error tied to one of the job's runner resources", () => {
  const environment = {
    NDDEV_DOCKER_HOST: "unix:///run/fixture-docker.sock",
    NDDEV_CI_ARTIFACT_REGISTRY: "http://cache.example.test:8000",
    HTTPS_PROXY: "http://proxy.example.test:3128",
    SCCACHE_DIR: "/runner/cache",
    RUNNER_TEMP: "/runner/tmp",
    BUN_INSTALL_CACHE_DIR: "/runner/cache/packages/bun",
    CARGO_HOME: "/opt/contour/cargo",
  };
  const cases = [
    ["Cannot connect to the Docker daemon at unix:///run/fixture-docker.sock", "docker-unavailable"],
    ['Docker GET unix:///run/fixture-docker.sock/_ping returned HTTP 502', "docker-unavailable"],
    ["sccache: failed to read /runner/cache/entry: Permission denied", "cache-unavailable"],
    ["sccache: error: Server startup failed: Operation not permitted (os error 1)", "cache-unavailable"],
    ["sccache: error: couldn't connect to server", "cache-unavailable"],
    ["sccache: error: Connection to server timed out", "cache-unavailable"],
    ["error[E0308]: mismatched types in sccache_test.rs", ""],
    ["http://cache.example.test:8000/packages: HTTP 503", "cache-unavailable"],
    ["failed to connect to proxy.example.test:3128: connection refused", "network-unavailable"],
    ["write /runner/tmp/file: no space left on device", "runner-storage"],
    ["Error: EDQUOT: unknown error, write", "disk-quota-exceeded"],
    ["write /srv/ci/buildkit/layer: Disk quota exceeded", "disk-quota-exceeded"],
    ['error: moving "@types/bun" to cache dir failed: EACCES: .9b9feb-3.bun: Permission denied (rename())', "bun-cache-eacces"],
    ["error: renaming changes to cache dir: EACCES: @hey-api/openapi-ts@0.99.0: Permission denied (rename())", "bun-cache-eacces"],
    ["fatal: detected dubious ownership in repository at '/opt/contour/cargo/advisory-dbs/advisory-db-3157b0e258782691'", "cargo-advisory-ownership"],
    ["fatal: detected dubious ownership in repository at '/tmp/project-repo'", ""],
    ["test did not finish within 300 s", ""],
    ['"docker" "--host" "unix:///run/project-docker.sock" "buildx" timed out', ""],
    ["http://cache.example.test:8000/packages: HTTP 404", ""],
    ["cache.example.test:80000: connection refused", ""],
    ["custom project server: connection refused", ""],
    ['{"event":"project.request","route":"ping","status":502}', ""],
    ["write /runner/tmp-other/file: no space left on device", ""],
  ];
  const classify = runnerFailureClassifier(environment);
  for (const [line, reason] of cases) assert.equal(classify(line), reason, line);
  const unconfigured = runnerFailureClassifier({});
  assert.equal(
    unconfigured("sccache: error: Server startup failed: Operation not permitted (os error 1)"),
    "",
  );
  const socketOnly = runnerFailureClassifier({ SCCACHE_SERVER_UDS: "/run/sccache/server.sock" });
  assert.equal(
    socketOnly("sccache: error: Server startup failed: Operation not permitted (os error 1)"),
    "cache-unavailable",
  );
});

test("missing, zero, stale, future or unreadable start files omit duration and empty repo/run emit empty URLs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "job-record-bounds-"));
  const now = new Date("2026-11-26T12:00:00Z");
  const nowSec = Math.round(now.getTime() / 1000);
  try {
    const started = path.join(root, "started");
    assert.equal(record({ ...base, "INPUT_STARTED-FILE": started }, now)["nddev_ci.duration_seconds"], undefined);
    assert.equal(record({ ...base, "INPUT_STARTED-FILE": root }, now)["nddev_ci.duration_seconds"], undefined);

    for (const content of [
      "",
      "0\n",
      "-10\n",
      "not-a-number\n",
      "12.5\n",
      `${nowSec - MAX_DURATION_SECONDS - 1}\n`,
      `${Date.parse("2025-06-14T11:56:55Z") / 1000}\n`,
      `${nowSec + MAX_FUTURE_SKEW_SECONDS + 1}\n`,
    ]) {
      writeFileSync(started, content);
      assert.equal(
        record({ ...base, "INPUT_STARTED-FILE": started }, now)["nddev_ci.duration_seconds"],
        undefined,
        `expected omitted duration for ${JSON.stringify(content)}`,
      );
    }

    for (const [value, expected] of [
      [nowSec, 0],
      [nowSec + MAX_FUTURE_SKEW_SECONDS, 0],
      [nowSec - MAX_DURATION_SECONDS, MAX_DURATION_SECONDS],
    ]) {
      writeFileSync(started, `${value}\n`);
      assert.equal(record({ ...base, "INPUT_STARTED-FILE": started }, now)["nddev_ci.duration_seconds"], expected);
    }

    const minimal = record({ INPUT_TASK: "check", INPUT_STATUS: "success" }, now);
    assert.equal(minimal["vcs.repository.url.full"], "");
    assert.equal(minimal["cicd.pipeline.run.url.full"], "");
    const repoOnly = record({ INPUT_TASK: "check", INPUT_STATUS: "success", GITHUB_REPOSITORY: "owner/repo" }, now);
    assert.equal(repoOnly["vcs.repository.url.full"], "https://github.com/owner/repo");
    assert.equal(repoOnly["cicd.pipeline.run.url.full"], "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upstream failure layer and bounded upstream-reason classify GitHub and GHCR errors outside project", () => {
  const failed = { ...base, INPUT_STATUS: "failure" };
  const direct = record({ ...failed, "INPUT_FAILURE-LAYER": "upstream", "INPUT_FAILURE-REASON": "github-5xx" });
  assert.equal(direct["nddev_ci.failure.layer"], "upstream");
  assert.equal(direct["nddev_ci.failure.reason"], "github-5xx");

  const attributed = record({
    ...failed,
    "INPUT_FAILURE-LAYER": "project",
    "INPUT_FAILURE-REASON": "project-command-failed",
    "INPUT_UPSTREAM-REASON": "github-5xx",
  });
  assert.equal(attributed["nddev_ci.failure.layer"], "upstream");
  assert.equal(attributed["nddev_ci.failure.reason"], "github-5xx");

  // Runner-host failure keeps precedence over upstream failure.
  const runnerWins = record({
    ...failed,
    "INPUT_FAILURE-LAYER": "project",
    "INPUT_RUNNER-REASON": "network-unavailable",
    "INPUT_UPSTREAM-REASON": "github-5xx",
  });
  assert.equal(runnerWins["nddev_ci.failure.layer"], "runner");
  assert.equal(runnerWins["nddev_ci.failure.reason"], "network-unavailable");

  const unknownUpstream = record({
    ...failed,
    "INPUT_FAILURE-LAYER": "project",
    "INPUT_FAILURE-REASON": "project-command-failed",
    "INPUT_UPSTREAM-REASON": "unrecognized",
  });
  assert.equal(unknownUpstream["nddev_ci.failure.layer"], "project");
  assert.equal(unknownUpstream["nddev_ci.failure.reason"], "project-command-failed");

  const classify = upstreamFailureClassifier();
  for (const [line, expected] of [
    ["GitHub read returned HTTP 500", "github-5xx"],
    ["GET https://api.github.com/repos/o/r/releases: HTTP 502 Bad Gateway", "github-5xx"],
    ["POST https://uploads.github.com/repos/o/r/releases/1/assets: 503 Service Unavailable", "github-5xx"],
    ["https://api.github.com/graphql failed: connection reset by peer", "github-transport"],
    ["GitHub transport did not complete (UND_ERR_CONNECT_TIMEOUT)", "github-transport"],
    ["ghcr.io/owner/repo/ci-artifacts: status 504 Gateway Timeout", "ghcr-5xx"],
    ["failed to push ghcr.io/owner/repo: unexpected EOF", "ghcr-transport"],
    ["GET https://api.github.com/repos/o/r/releases: HTTP 404", ""],
    ["GET https://api.github.com/repos/o/r/releases: HTTP 403", ""],
    ["http://127.0.0.1:8080/api.github.com: HTTP 500", ""],
    ["assertion failed: expected HTTP 500 from https://api.github.com", ""],
    ["test github_500_retry ... FAILED", ""],
  ]) {
    assert.equal(classify(line), expected, line);
  }
});

test("runProjectCommand emits upstream-reason on failure and lets runner-reason take precedence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "project-cmd-upstream-"));
  try {
    for (const [name, script, exitCode, expected] of [
      ["upstream", 'console.error("GitHub read returned HTTP 500"); process.exit(1);', 1, "upstream-reason=github-5xx\n"],
      ["runner", 'console.error("GitHub read returned HTTP 500"); console.error("write /srv/ci/layer: Disk quota exceeded"); process.exit(1);', 1, "runner-reason=disk-quota-exceeded\n"],
      ["success", 'console.error("GitHub read returned HTTP 500"); process.exit(0);', 0, null],
    ]) {
      const out = path.join(root, `${name}.out`);
      const code = await runProjectCommand(process.execPath, ["-e", script], {
        environment: { ...process.env, RUNNER_ENVIRONMENT: "self-hosted" },
        output: out,
      });
      assert.equal(code, exitCode, name);
      if (expected === null) assert.equal(existsSync(out), false, name);
      else assert.equal(readFileSync(out, "utf8"), expected, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
