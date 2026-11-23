import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {main as record, record as jobRecord} from "../actions/job-record/run.mjs";
import {dailySlot} from "../lib/security-schedule.mjs";
import {inspect} from "../tools/security-schedule.mjs";

const cron = "17 3 * * *";
const anchor = "2025-06-14T20:00:00Z";
const scheduled = {id: 10, event: "schedule", created_at: "2025-06-14T11:47:23Z", run_attempt: 2};

test("daily fixed UTC slots cross midnight and unrecognized schedules have no assumed slot", () => {
  assert.equal(dailySlot(cron, anchor), Date.parse("2025-06-14T03:17:00Z"));
  assert.equal(dailySlot(cron, "2025-06-15T02:00:00Z"), Date.parse("2025-06-14T03:17:00Z"));
  for (const invalid of ["0 5 * * MON", "60 1 * * *", "0 24 * * *", "0 1,2 * * *", ""])
    assert.equal(dailySlot(invalid, anchor), null);
});

test("a late GitHub schedule separates run creation delay from time before the first job", () => {
  const requested = [];
  const lines = inspect("fixture/repo", "security.yml", cron, anchor, (route) => {
    requested.push(route);
    if (requested.length === 1) return {total_count: 1, workflow_runs: [scheduled]};
    return {total_count: 3, jobs: [
      {status: "completed", conclusion: "success", started_at: "2025-06-14T12:03:00Z"},
      {status: "queued", conclusion: null, started_at: "2025-06-14T11:47:24Z"},
      {status: "completed", conclusion: "success", started_at: "2025-06-14T11:56:55Z"},
    ]};
  });
  const query = new URL(requested[0], "https://api.example.test").searchParams;
  assert.equal(query.get("event"), "schedule");
  assert.equal(query.get("created"), "2025-06-14T03:17:00.000Z..2025-06-15T03:16:59.999Z");
  assert.match(requested[1], /runs\/10\/attempts\/1\/jobs/);
  assert.match(lines[1], /late by 8h 30m 23s/);
  assert.match(lines[2], /9m 32s after run creation/);
});

test("an unlisted slot may still be delayed, and incomplete or ambiguous evidence cannot assign an exact run", () => {
  const check = (rows, total = rows.length) => inspect("fixture/repo", "security.yml", cron, anchor,
    () => ({total_count: total, workflow_runs: rows}));
  assert.match(check([])[1], /has yet to appear/);
  assert.match(check([scheduled, {...scheduled, id: 11}])[1], /intended times are unknown/);
  assert.throws(() => check([scheduled], 2), /incomplete schedule evidence/);
  assert.throws(() => check([{...scheduled, event: "workflow_dispatch"}]), /incomplete schedule evidence/);
  assert.throws(() => check([{...scheduled, created_at: "2025-06-13T11:47:23Z"}]), /incomplete schedule evidence/);
});

test("the local job record measures the first scheduled job start and prints runner wait separately", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "security-schedule-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const started = path.join(directory, "started");
  const summary = path.join(directory, "summary");
  writeFileSync(started, String(Date.parse("2025-06-14T11:56:55Z") / 1000));
  const env = {INPUT_TASK: "daily security", INPUT_STATUS: "success", INPUT_SCHEDULE: cron, GITHUB_RUN_ATTEMPT: "1",
    "INPUT_STARTED-FILE": started, GITHUB_EVENT_NAME: "schedule", GITHUB_STEP_SUMMARY: summary, NDDEV_CI_QUEUE_SECONDS: "572"};
  record(env);
  const text = readFileSync(summary, "utf8");
  assert.match(text, /03:17:00.000Z.*started late by 8h 39m 55s/);
  assert.match(text, /Measured runner wait was 9m 32s/);
  for (const update of [{GITHUB_RUN_ATTEMPT: "2"}, {GITHUB_EVENT_NAME: "workflow_dispatch"}, {INPUT_SCHEDULE: "unknown"}])
    assert.equal(jobRecord({...env, ...update})["nddev_ci.schedule.expected_at"], undefined);
});
