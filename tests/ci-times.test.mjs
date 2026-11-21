import assert from "node:assert/strict";
import test from "node:test";
import { measure, percentile, summarize, table } from "../tools/ci-times.mjs";

const at = (minute) => new Date(Date.UTC(2026, 10, 21, 12, minute)).toISOString();
const job = (name, queued, started, done, conclusion = "success") =>
  ({name, created_at: at(queued), started_at: at(started), completed_at: at(done), conclusion});
const run = {created_at: at(0)};

test("the nearest-rank percentile takes the value at or above the share", () => {
  const twenty = Array.from({length: 20}, (_, index) => index + 1);
  assert.equal(percentile(twenty, 0.9), 18);
  assert.equal(percentile(twenty, 0.5), 10);
  assert.equal(percentile(twenty, 1), 20);
  assert.equal(percentile([], 0.9), undefined);
});

test("one job's full check answers when that job completes", () => {
  const row = measure(run, [job("check / full check", 0, 2, 20), job("check / merge-stops", 0, 0, 0, "skipped")]);
  assert.deepEqual(row, {check: "full check", conclusion: "success", answer: 1200, wait: 120, longest: 1080, jobs: 1});
});

test("a full check in parts answers at its joined result, with its longest wait and part", () => {
  const row = measure(run, [
    job("check / plan", 0, 1, 2), job("check / verify test", 2, 3, 9), job("check / verify image", 2, 6, 10),
    job("check / full check", 10, 10, 11, "failure"),
  ]);
  assert.deepEqual(row, {check: "full check", conclusion: "failure", answer: 660, wait: 240, longest: 360, jobs: 4});
});

test("a run without a finished result is not an answer", () => {
  assert.equal(measure(run, [job("check / short check", 0, 1, 3, "cancelled")]), null);
  assert.equal(measure(run, [job("build", 0, 1, 3)]), null);
  assert.equal(measure(run, [{...job("check / short check", 0, 1, 3), started_at: null}]), null);
});

test("the summary keeps each check apart and counts red answers", () => {
  const rows = [measure(run, [job("check / short check", 0, 1, 3)]), measure(run, [job("check / short check", 0, 2, 6, "failure")])];
  const [short] = summarize(rows);
  assert.deepEqual(short, {check: "short check", runs: 2, failed: 1, answer: "3.0 / 6.0 / 6.0", wait: "1.0 / 2.0 / 2.0", longest: "2.0 / 4.0 / 4.0", jobs: 1});
  assert.equal(summarize([]).length, 0);
  assert.match(table("owner/name", [short]), /\| owner\/name \| short check \| 2 \(1\) \| 3\.0 \/ 6\.0 \/ 6\.0 \|/);
});
