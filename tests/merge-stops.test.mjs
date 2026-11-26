import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    // Project stop failure must fail the run and record failure-layer=project and failure-reason.
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
    assert.equal(readFileSync(output, "utf8"), "failure-layer=project\nfailure-reason=merge-stops-failed\n");

    // Named stop reason and stale PR merge-base reason propagate distinctly.
    writeFileSync(output, "");
    const namedFail = await runMergeStops(
      { GITHUB_WORKSPACE: root, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
      {
        customChecks: [
          { ...delayed("No new code clones", true, 1, 5), reason: "merge-stop-clones" },
        ],
      },
    );
    assert.equal(namedFail, 1);
    assert.equal(readFileSync(output, "utf8"), "failure-layer=project\nfailure-reason=merge-stop-clones\n");

    writeFileSync(output, "");
    const staleBase = await runMergeStops(
      { GITHUB_WORKSPACE: root, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
      {
        customChecks: [{
          name: "No new fixed critical dependency",
          reason: "merge-stop-dependencies",
          projectStop: true,
          async run() {
            return {
              status: 1,
              output: "::error::Dependency merge base is neither the PR base nor a later commit of it.\n",
            };
          },
        }],
      },
    );
    assert.equal(staleBase, 1);
    assert.equal(readFileSync(output, "utf8"), "failure-layer=project\nfailure-reason=stale-pr-merge-base\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inline merge stops read the exact merge in a separate worktree and remove it on failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "inline-merge-stops-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();

  try {
    git("init", "--quiet");
    const marker = path.join(workspace, "marker");
    writeFileSync(marker, "checked source");
    git("add", "marker");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture");
    const merge = git("rev-parse", "HEAD");
    writeFileSync(marker, "workspace-only change");
    let inspected;
    const result = await runMergeStops({
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: root,
      MERGE_STOPS_ISOLATED_WORKTREE: "true",
      MERGE_STOPS_MERGE: merge,
      GITHUB_OUTPUT: "",
      GITHUB_STEP_SUMMARY: "",
    }, {
      customChecks: [{
        name: "Inspect the checked source",
        projectStop: true,
        run({ cwd, env }) {
          inspected = cwd;
          assert.notEqual(cwd, workspace);
          assert.equal(env.GITHUB_WORKSPACE, cwd);
          assert.equal(readFileSync(path.join(cwd, "marker"), "utf8"), "checked source");
          return { status: 1, output: "" };
        },
      }],
    });
    assert.equal(result, 1);
    assert.ok(inspected);
    assert.equal(existsSync(inspected), false);
    assert.equal(git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
    assert.equal(readFileSync(marker, "utf8"), "workspace-only change");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
