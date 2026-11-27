import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkWorkflowActions,
  loadRegistrySnapshot,
  prepareActionFromRegistry,
  resolveAction,
} from "../lib/registry-resolve.mjs";

function writeSnapshot(dir, toml, commit = "d".repeat(40)) {
  const file = path.join(dir, "registry.json");
  writeFileSync(file, JSON.stringify({
    schema_version: 1,
    registry_commit: commit,
    technologies_toml: toml,
  }));
  return file;
}

test("action kind resolves commit SHAs, checks workflow uses and materializes pinned actions from snapshot", () => {
  const root = mkdtempSync(path.join(tmpdir(), "reg-action-"));
  try {
    // Create a real local Git repository fixture with two commits representing v1 and v2 of an action.
    const repoDir = path.join(root, "fixture-action");
    mkdirSync(repoDir, { recursive: true });
    const git = (...args) => execFileSync("git", [
      "-c", "user.name=Fixture",
      "-c", "user.email=fixture@example.test",
      "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=/dev/null",
      ...args,
    ], { cwd: repoDir, encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(path.join(repoDir, "action.yml"), "name: Fixture v1\n");
    git("add", ".");
    git("commit", "-qm", "feat: v1");
    const shaV1 = git("rev-parse", "HEAD");
    writeFileSync(path.join(repoDir, "action.yml"), "name: Fixture v2\n");
    git("add", ".");
    git("commit", "-qm", "feat: v2");
    const shaV2 = git("rev-parse", "HEAD");

    const toml = `
[technologies."actions/checkout"]
kind = "action"
lines = [{ version = "7.0.1", role = "latest", commit = "${shaV1}" }]

[technologies."actions/cache"]
kind = "action"
lines = [{ version = "6.1.0", role = "latest", commit = "${shaV2}" }]
`;
    const snapPath = writeSnapshot(root, toml);
    const snapshot = loadRegistrySnapshot({ NDDEV_CI_REGISTRY_SNAPSHOT: snapPath });

    // Subpath actions normalize to owner/repo and resolve exact commit SHA.
    const resolvedCache = resolveAction(snapshot, "actions/cache/restore");
    assert.equal(resolvedCache.commit, shaV2);
    assert.equal(resolvedCache.ref, `actions/cache/restore@${shaV2}`);
    assert.throws(() => resolveAction(snapshot, "actions/checkout", "0".repeat(40)), /outside the snapshot/);

    // Workflow checking validates external actions while ignoring local, $/ and reusable workflow calls.
    const checkOk = checkWorkflowActions(snapshot, [{
      path: ".github/workflows/ci.yml",
      content: [
        "jobs:",
        "  a:",
        "    uses: Example-Org/ci/.github/workflows/check.yml@" + shaV1,
        "  b:",
        "    steps:",
        `      - uses: actions/checkout@${shaV1}`,
        `      - uses: actions/cache/restore@${shaV2}`,
        "      - uses: $/actions/prepare",
        "      - uses: ./actions/local",
      ].join("\n"),
    }]);
    assert.equal(checkOk.violations.length, 0);
    assert.equal(checkOk.checked.length, 2);

    const checkBad = checkWorkflowActions(snapshot, [{
      path: ".github/workflows/bad.yml",
      content: [
        "steps:",
        "  - uses: actions/checkout@v7",
        `  - uses: actions/checkout@${"0".repeat(40)}`,
        `  - uses: unknown/action@${shaV1}`,
      ].join("\n"),
    }]);
    assert.equal(checkBad.violations.length, 3);
    assert.match(checkBad.violations[0].reason, /not a 40-character commit SHA/);
    assert.match(checkBad.violations[1].reason, /outside the snapshot/);
    assert.match(checkBad.violations[2].reason, /does not declare action/);

    // Materialize exact commit from snapshot without hardcoded SHAs.
    const dest = path.join(root, "staged-action");
    const installed = prepareActionFromRegistry(snapshot, "actions/checkout", dest, { sourceUrl: repoDir });
    assert.equal(installed.commit, shaV1);
    assert.equal(
      readFileSync(path.join(dest, "action.yml"), "utf8").replace(/\r\n/g, "\n"),
      "name: Fixture v1\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
