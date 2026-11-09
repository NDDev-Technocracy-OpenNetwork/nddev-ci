import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sources, materialize } from "../lib/dependency-source.mjs";

function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "ci-dependency-git-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (file, content) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), content); };
  const commit = () => { git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "fixture"); return git("rev-parse", "HEAD"); };
  const merge = (base, head) => {
    const id = git("commit-tree", `${head}^{tree}`, "-p", base, "-p", head, "-m", "fixture merge");
    git("checkout", "--detach", id);
    return { base, head, merge: id };
  };
  try { git("init", "--initial-branch=fixture"); run({ root, git, write, commit, merge }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("the guard reads committed lock bytes and never the changed working tree or executable scripts", () => fixture(({ root, write, commit, merge }) => {
  write("project with spaces/package-lock.json", '{"old":true}');
  write("package.json", '{"scripts":{"install":"must never run"}}');
  const base = commit();
  write("project with spaces/package-lock.json", '{"committed":true}');
  const head = commit();
  const revisions = merge(base, head);
  write("project with spaces/package-lock.json", '{"uncommitted":true}');
  const input = sources(root, revisions);
  assert.equal(input.changed, true);
  const out = path.join(root, "output");
  const receipt = materialize(root, input.head, out);
  assert.equal(readFileSync(path.join(out, "project with spaces/package-lock.json"), "utf8"), '{"committed":true}');
  assert.equal(receipt.length, 1);
  assert.match(receipt[0].sha256, /^[a-f0-9]{64}$/);
}));
test("a source-only change skips and a dependency declaration still selects all committed locks", () => fixture(({ root, write, commit, merge }) => {
  write("Cargo.lock", "version=4\n");
  write("Cargo.toml", "[package]\nname='example'\n");
  const base = commit();
  write("src.txt", "source only");
  const first = commit();
  assert.equal(sources(root, merge(base, first)).changed, false);
  write("Cargo.toml", "[package]\nname='renamed'\n");
  const second = commit();
  const input = sources(root, merge(first, second));
  assert.equal(input.changed, true);
  assert.deepEqual(input.head.map((e) => e.path), ["Cargo.lock"]);
}));
test("only exact merge parents and the checked out merge may be compared", () => fixture(({ root, write, commit, merge }) => {
  write("uv.lock", "version=1\n"); const base = commit();
  write("uv.lock", "version=2\n"); const head = commit();
  const revisions = merge(base, head);
  assert.throws(() => sources(root, { ...revisions, head: base }), /exact PR base and head/);
  assert.throws(() => sources(root, { ...revisions, base: "dev" }), /exact Git commit/);
  assert.throws(() => sources(root, { ...revisions, merge: head }), /exact PR base and head/);
}));
test("Git renames preserve a finding's lock scope", () => fixture(({ root, write, commit, merge }) => {
  write("old/Cargo.lock", "version=4\n"); const base = commit();
  mkdirSync(path.join(root, "new")); renameSync(path.join(root, "old/Cargo.lock"), path.join(root, "new/Cargo.lock"));
  const head = commit();
  assert.equal(sources(root, merge(base, head)).renames.get("old/Cargo.lock"), "new/Cargo.lock");
}));
test("a lockfile symlink is refused from Git metadata without following its target", () => fixture(({ root, git, write, commit, merge }) => {
  write("package-lock.json", "external target"); const base = commit();
  const oid = git("rev-parse", `${base}:package-lock.json`);
  git("update-index", "--cacheinfo", `120000,${oid},package-lock.json`);
  const tree = git("write-tree");
  const head = git("commit-tree", tree, "-p", base, "-m", "fixture symlink");
  const merged = git("commit-tree", tree, "-p", base, "-p", head, "-m", "fixture merge");
  // Keep HEAD exact without checking out an untrusted link.
  git("update-ref", "HEAD", merged);
  assert.throws(() => sources(root, { base, head, merge: merged }), /regular tracked/);
}));
