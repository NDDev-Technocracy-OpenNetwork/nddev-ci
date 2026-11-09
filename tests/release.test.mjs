import assert from "node:assert/strict";
import test from "node:test";

import {
  ReleaseError,
  artifactNames,
  checkFiles,
  checksums,
  nextVersion,
  parseVersion,
  selectQualifiedRun,
} from "../lib/release.mjs";

const sha = "a".repeat(40);
const repository = "owner/project";
const where = { sha, repository, workflowPath: ".github/workflows/ci.yml", branch: "dev" };
const run = (fields) => ({
  id: 1,
  run_number: 10,
  run_attempt: 1,
  run_started_at: "2026-11-09T12:00:00Z",
  head_sha: sha,
  head_branch: "dev",
  event: "push",
  path: ".github/workflows/ci.yml",
  status: "completed",
  conclusion: "success",
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  ...fields,
});

test("versions have three plain numbers", () => {
  assert.deepEqual(parseVersion("1.20.3"), [1, 20, 3]);
  for (const text of ["1.2", "1.2.3.4", "01.2.3", "1.2.3-rc1", "v1.2.3", "", undefined])
    assert.equal(parseVersion(text), null, String(text));
});

test("an ordinary release raises the last number of the newest release", () => {
  const tags = ["v0.6.25", "v0.6.9", "v0.5.40", "history/44-x", "nddev-ci-v0.9.0", "vnext"];
  assert.equal(nextVersion({ tags, initial: "0.1.0" }), "0.6.26");
  assert.equal(nextVersion({ tags: [], initial: "0.6.26" }), "0.6.26");
  assert.equal(nextVersion({ tags: ["history/1"], initial: "1.0.0" }), "1.0.0");
});

test("a chosen version must be newer than every release", () => {
  const tags = ["v1.4.2"];
  assert.equal(nextVersion({ tags, explicit: "1.5.0" }), "1.5.0");
  assert.equal(nextVersion({ tags, explicit: "2.0.0" }), "2.0.0");
  for (const explicit of ["1.4.2", "1.4.1", "1.3.9", "1.5"])
    assert.throws(() => nextVersion({ tags, explicit }), ReleaseError, explicit);
});

test("the newest check of the exact commit qualifies it", () => {
  const selected = selectQualifiedRun([run({ id: 7 })], where);
  assert.equal(selected.state, "qualified");
  assert.equal(selected.run.id, 7);
  const rerun = selectQualifiedRun(
    [run({ id: 7, run_attempt: 1, conclusion: "failure" }), run({ id: 7, run_attempt: 2 })],
    where,
  );
  assert.equal(rerun.state, "qualified");
  assert.equal(rerun.run.run_attempt, 2);
});

test("an older green check never replaces a newer failed, cancelled or running one", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", null]) {
    const selected = selectQualifiedRun(
      [run({ id: 1, run_number: 10 }), run({ id: 2, run_number: 11, conclusion })],
      where,
    );
    assert.equal(selected.state, "failed", String(conclusion));
    assert.equal(selected.run.id, 2);
  }
  const pending = selectQualifiedRun(
    [run({ id: 1 }), run({ id: 2, run_number: 11, status: "in_progress", conclusion: null })],
    where,
  );
  assert.equal(pending.state, "pending");
});

test("other commits, branches, events, workflows and repositories never qualify", () => {
  const foreign = [
    run({ head_sha: "b".repeat(40) }),
    run({ head_branch: "main" }),
    run({ event: "workflow_dispatch" }),
    run({ event: "pull_request" }),
    run({ path: ".github/workflows/other.yml" }),
    run({ repository: { full_name: "other/project" } }),
    run({ head_repository: { full_name: "fork/project" } }),
  ].map((entry, index) => ({...entry, id: index + 1, run_number: index + 10}));
  assert.equal(selectQualifiedRun(foreign, where).state, "missing");
  assert.throws(() => selectQualifiedRun([], { ...where, sha: "abc" }), ReleaseError);
  assert.throws(() => selectQualifiedRun(new Array(101).fill(run({})), where), ReleaseError);
});

test("malformed newer evidence cannot fall back to an older successful run", () => {
  for (const fields of [{repository: null}, {id: undefined}, {run_number: "11"}, {run_attempt: 0},
    {run_started_at: "unknown"}, {status: "unknown", conclusion: null}])
    assert.throws(() => selectQualifiedRun([run({}), run({id: 2, run_number: 11, ...fields})], where), ReleaseError);
});

test("contradictory run ordering and repeated attempts cannot select a green record", () => {
  for (const next of [run({id: 2}), run({run_number: 11}), run({conclusion: "failure"})])
    assert.throws(() => selectQualifiedRun([run({}), next], where), /contradictory/);
});

test("artifact names are plain, bounded and unique", () => {
  assert.deepEqual(artifactNames("build\n  linux-x64 \n\n"), ["build", "linux-x64"]);
  for (const text of ["../build", "a b", "build\nbuild", ".hidden"])
    assert.throws(() => artifactNames(text), ReleaseError, text);
  assert.throws(() => artifactNames(Array.from({ length: 33 }, (_, i) => `a${i}`).join("\n")));
});

test("published files are plain, unique without case, bounded and summed", () => {
  const file = (name, size = 3) => ({ name, size, sha256: "c".repeat(64) });
  const files = checkFiles([file("tool-linux.tar.gz"), file("Tool.zip")]);
  assert.deepEqual(
    files.map((item) => item.name),
    ["Tool.zip", "tool-linux.tar.gz"],
  );
  assert.equal(
    checksums(files),
    `${"c".repeat(64)}  Tool.zip\n${"c".repeat(64)}  tool-linux.tar.gz\n`,
  );
  for (const bad of [
    [file("a"), file("A")],
    [file("SHA256SUMS")],
    [file("../a")],
    [file(".env")],
    [file("a", 0)],
    [{ name: "a", size: 1, sha256: "x" }],
  ])
    assert.throws(() => checkFiles(bad), ReleaseError);
});
