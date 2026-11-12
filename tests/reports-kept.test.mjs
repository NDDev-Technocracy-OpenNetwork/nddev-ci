import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The step that refuses a named report the job did not leave, as both reusable workflows run it.
function step(workflow) {
  const text = readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8");
  const start = text.indexOf("      - name: Every named report is kept\n");
  assert.notEqual(start, -1, workflow);
  const end = text.indexOf("\n      - name: ", start + 1);
  return text.slice(start, end).split("        run: |\n")[1]
    .split("\n").filter((line) => line.startsWith("          ")).map((line) => line.slice(10)).join("\n");
}

const scripts = ["recipe.yml", "check.yml"].map((workflow) => [workflow, step(workflow)]);

test("both workflows run the same report check", () => {
  assert.equal(scripts[0][1], scripts[1][1]);
});

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "nddev-ci-reports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "ci-reports", "junit"), { recursive: true });
  writeFileSync(join(root, "ci-reports", "qualification.json"), "{}\n");
  writeFileSync(join(root, "ci-reports", "junit", "suite.xml"), "<testsuite/>\n");
  mkdirSync(join(root, "empty"));
  mkdirSync(join(root, "hidden-only", ".cache"), { recursive: true });
  writeFileSync(join(root, "hidden-only", ".cache", "report.json"), "{}\n");
  return root;
}

function run(root, reports) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", scripts[0][1]], {
    cwd: root,
    env: { PATH: process.env.PATH, REPORTS: reports },
    encoding: "utf8",
  });
}

test("every named file, folder and pattern that the job left passes", (t) => {
  const root = workspace(t);
  const result = run(root, "ci-reports/qualification.json\nci-reports/junit\n\nci-reports/**/*.xml\n");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
});

test("a missing report fails even when another named report is there", (t) => {
  const root = workspace(t);
  const result = run(root, "ci-reports/qualification.json\nci-reports/missing.json\n");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::reports names ci-reports\/missing\.json, and the job left nothing there/);
  assert.doesNotMatch(result.stdout, /qualification\.json/);
});

test("an empty folder, a folder of hidden files and an unmatched pattern count as missing", (t) => {
  const root = workspace(t);
  const result = run(root, "empty\nhidden-only\nci-reports/*.sarif\n");
  assert.equal(result.status, 1);
  for (const name of ["empty", "hidden-only", "ci-reports/\\*\\.sarif"]) {
    assert.match(result.stdout, new RegExp(`reports names ${name}, and the job left nothing there`));
  }
});
