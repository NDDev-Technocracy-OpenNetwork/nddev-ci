import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { main, record, sccache } from "../actions/job-record/run.mjs";

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
  try {
    const sink = path.join(root, "ci.jsonl");
    main({ ...base, NDDEV_CI_TELEMETRY_FILE: sink, GITHUB_STEP_SUMMARY: path.join(root, "summary.md") });
    main({ ...base, INPUT_STATUS: "failure", NDDEV_CI_TELEMETRY_FILE: sink });
    const lines = readFileSync(sink, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line["cicd.pipeline.task.run.result"]), ["success", "failure"]);
    assert.match(readFileSync(path.join(root, "summary.md"), "utf8"), /short check: success/);
    assert.throws(() => main({ ...base, NDDEV_CI_TELEMETRY_FILE: "relative.jsonl" }), /absolute path/);
    assert.throws(() => main({ ...base, NDDEV_CI_TELEMETRY_FILE: root }), /regular file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
