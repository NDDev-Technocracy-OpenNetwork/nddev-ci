import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareTiming, measure } from "../actions/planner-speed/run.mjs";

test("the planner speed stop compares medians and allows exactly the margin", () => {
  const base = [103, 1000, 99, 100, 98];
  assert.deepEqual(compareTiming(base, [109, 110, 111, 1200, 108], 10),
    {base: 100, merge: 110, slower: false});
  assert.deepEqual(compareTiming(base, [111, 108, 3600, 110, 120], 10),
    {base: 100, merge: 111, slower: true});
});

test("invalid or incomplete measurements cannot qualify the planner", () => {
  assert.throws(() => compareTiming([10, 10], [10, 10], 10), /five positive timings/);
  assert.throws(() => compareTiming([10, 10, 10, 10, 0], [10, 10, 10, 10, 10], 10),
    /five positive timings/);
});

test("a worker measures the library planner with the benchmark graph", () => {
  const planner = fileURLToPath(new URL("../lib/verify-parts.mjs", import.meta.url));
  assert.ok(measure(planner) > 0);
});
