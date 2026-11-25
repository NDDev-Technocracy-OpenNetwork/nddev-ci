import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runMergeStops } from "../actions/merge-stops/run.mjs";

test("merge-stops runner executes independent checks concurrently, preserves summaries and separates hints from stops", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "merge-stops-runner-"));
  try {
    const summary = path.join(root, "summary.md");
    const output = path.join(root, "output.txt");
    writeFileSync(summary, "");
    writeFileSync(output, "");

    let active = 0;
    let peak = 0;
    const delayed = (name, projectStop, status, ms, extraSummary = "") => ({
      name,
      projectStop,
      summaryFile: extraSummary ? path.join(root, `${name.replace(/\W+/g, "-")}.md`) : "",
      async run() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, ms));
        active -= 1;
        if (extraSummary) writeFileSync(this.summaryFile, extraSummary);
        return { status, output: `${name} ran\n` };
      },
    });

    // Hint failure must not fail the run or set failure-layer=project.
    const hintOnly = await runMergeStops(
      { GITHUB_WORKSPACE: root, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
      {
        customChecks: [
          delayed("Stop A", true, 0, 40, "## Dependency comparison\n"),
          delayed("Stop B", true, 0, 40),
          delayed("Hint C", false, 1, 40),
        ],
      },
    );
    assert.equal(hintOnly, 0);
    assert.ok(peak >= 2, `expected concurrent checks, peak=${peak}`);
    assert.equal(readFileSync(output, "utf8"), "");
    assert.match(readFileSync(summary, "utf8"), /## Dependency comparison/);

    // Project stop failure must fail the run and record failure-layer=project.
    writeFileSync(output, "");
    const failed = await runMergeStops(
      { GITHUB_WORKSPACE: root, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
      {
        customChecks: [
          delayed("Stop Pass", true, 0, 10),
          delayed("Stop Fail", true, 1, 10),
        ],
      },
    );
    assert.equal(failed, 1);
    assert.equal(readFileSync(output, "utf8"), "failure-layer=project\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
