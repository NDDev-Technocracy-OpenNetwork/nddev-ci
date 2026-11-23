import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../actions/secret-scan/run.mjs";

function fixture(t, policy) {
  const root = mkdtempSync(path.join(os.tmpdir(), "base-secret-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "source");
  const temporary = path.join(root, "temporary");
  mkdirSync(workspace); mkdirSync(temporary);
  const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: workspace, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  git("init", "-q");
  writeFileSync(path.join(workspace, "README"), "Source fixture\n");
  if (policy !== undefined) writeFileSync(path.join(workspace, ".gitleaks.toml"), policy);
  git("add", "."); git("commit", "-qm", "feat: create the base");
  const base = git("rev-parse", "HEAD");
  return { workspace, temporary, git, base, environment: () => ({ ...process.env, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temporary, INPUT_BASE: base, INPUT_HEAD: git("rev-parse", "HEAD") }) };
}
const token = () => ["ghp", randomBytes(18).toString("hex")].join("_");
const allow = (value) => `[extend]\nuseDefault = true\n[allowlist]\nregexes = ['${value}']\n`;

function commit(f, file, contents) {
  writeFileSync(path.join(f.workspace, file), contents);
  f.git("add", file);
  f.git("commit", "-qm", "test: update the fixture");
  return f.git("rev-parse", "HEAD");
}

function pushFixture(t, policy) {
  const f = fixture(t, policy);
  const receiver = path.join(f.temporary, "receiver.git");
  const hooks = path.join(f.temporary, "hooks");
  mkdirSync(hooks);
  f.git("init", "--bare", "--initial-branch=dev", receiver);
  f.git("remote", "add", "origin", receiver);
  f.git("push", "-q", "origin", "HEAD:refs/heads/dev");
  f.git("remote", "set-head", "origin", "dev");
  const entry = fileURLToPath(new URL("../tools/scan-before-push.mjs", import.meta.url));
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(path.join(hooks, "pre-push"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`,
    {mode: 0o700});
  const push = (...refs) => spawnSync("git", ["-c", `core.hooksPath=${hooks}`, "push", "-q", "origin", ...refs],
    {cwd: f.workspace, encoding: "utf8"});
  const objectWasReceived = (oid) => spawnSync("git", ["--git-dir", receiver, "cat-file", "-e", oid]).status === 0;
  return {...f, push, objectWasReceived};
}

test("an actual Git push refuses a secret removed by a later commit before sending either object", (t) => {
  const f = pushFixture(t);
  const finding = commit(f, "credential.env", `credential=${token()}\n`);
  const fixed = commit(f, "credential.env", "fixture only\n");
  f.git("tag", "-am", "Fixture", "candidate", fixed);
  for (const refs of [["HEAD:refs/heads/task"], ["refs/tags/candidate"],
    ["HEAD:refs/heads/task", "refs/tags/candidate"]]) {
    const result = f.push(...refs);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Pre-push secret scan: The change secret scan failed/);
    assert.equal(f.objectWasReceived(finding), false);
    assert.equal(f.objectWasReceived(fixed), false);
  }
});

test("ordinary pushes exclude the remote's published task commits and deletion-only pushes need no scan", (t) => {
  const f = pushFixture(t);
  const clean = commit(f, "fixture.txt", "clean\n");
  assert.equal(f.push("HEAD:refs/heads/task").status, 0);
  assert.equal(f.objectWasReceived(clean), true);
  // Seed an older published topic commit to prove the next update scans only the new commits.
  const published = commit(f, "fixture.env", `credential=${token()}\n`);
  f.git("push", "-q", "origin", "HEAD:refs/heads/task");
  const tip = commit(f, "fixture.txt", "clean update\n");
  const result = f.push("HEAD:refs/heads/task");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.objectWasReceived(published), true);
  assert.equal(f.objectWasReceived(tip), true);
  assert.equal(f.push(":refs/heads/task").status, 0);
});

test("the trusted policy parser uses the system TOML library even from a checkout with a similarly named module", (t) => {
  const f = pushFixture(t);
  const clean = commit(f, "tomllib.py", 'raise RuntimeError("the checkout module must not run")\n');
  const result = f.push("HEAD:refs/heads/task");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.objectWasReceived(clean), true);
});

test("the trusted fixture rule requires both an exact synthetic value and its approved path", (t) => {
  const value = token();
  const policy = `[extend]\nuseDefault = true\n[[allowlists]]\ncondition = "AND"\npaths = ['^fixture[.]env$']\nregexes = ['^${value}$']\n`;
  const f = pushFixture(t, policy);
  commit(f, "fixture.env", `credential=${value}\n`);
  main(f.environment());
  const allowed = f.push("HEAD:refs/heads/task");
  assert.equal(allowed.status, 0, allowed.stderr);

  commit(f, "other.env", `credential=${value}\n`);
  assert.throws(() => main(f.environment()), /secret scan failed/);
  assert.match(f.push("HEAD:refs/heads/task").stderr, /secret scan failed/);
});

test("the change scan includes secret additions made by a merge commit", (t) => {
  const f = pushFixture(t);
  const other = commit(f, "fixture.txt", "clean side branch\n");
  f.git("checkout", "--detach", f.base);
  const first = commit(f, "README", "clean first parent\n");
  writeFileSync(path.join(f.workspace, "fixture.env"), `credential=${token()}\n`);
  f.git("add", "fixture.env");
  const merge = f.git("commit-tree", f.git("write-tree"), "-p", first, "-p", other, "-m", "test: create a merge");
  f.git("checkout", "--detach", merge);
  assert.throws(() => main(f.environment()), /secret scan failed/);
  assert.match(f.push("HEAD:refs/heads/task").stderr, /secret scan failed/);
  assert.equal(f.objectWasReceived(merge), false);
});

test("the actual scanner accepts a previously trusted fixture that defaults reject", (t) => {
  const value = token(); const f = fixture(t, allow(value));
  writeFileSync(path.join(f.workspace, "token.env"), `credential=${value}\n`);
  f.git("add", "."); f.git("commit", "-qm", "test: add the public fixture");
  const before = spawnSync("betterleaks", ["git", "--no-banner", "--redact", `--log-opts=${f.base}..HEAD`, "."], { cwd: f.workspace, encoding: "utf8" });
  assert.equal(before.status, 1, "the original default-only invocation rejects the fixture");
  main(f.environment());
  assert.deepEqual(readdirSync(f.temporary), []);
});

test("head configuration, ignore files, inline comments and environment cannot suppress a new finding", (t) => {
  const f = fixture(t, allow(token()));
  writeFileSync(path.join(f.workspace, "token.env"), `credential=${token()} # gitleaks:allow\n`);
  f.git("add", "."); f.git("commit", "-qm", "test: add a forbidden finding");
  const report = path.join(f.temporary, "before.json");
  const scan = spawnSync("betterleaks", ["git", "--no-banner", "--redact", "--ignore-gitleaks-allow", "--report-format=json", `--report-path=${report}`, `--log-opts=${f.base}..HEAD`, "."], { cwd: f.workspace, encoding: "utf8" });
  assert.equal(scan.status, 1);
  const findings = JSON.parse(readFileSync(report, "utf8")); assert.ok(findings.length);
  rmSync(report);
  writeFileSync(path.join(f.workspace, ".gitleaks.toml"), allow(".*"));
  writeFileSync(path.join(f.workspace, ".betterleaksignore"), findings.map((f) => f.Fingerprint).join("\n") + "\n");
  f.git("add", "."); f.git("commit", "-qm", "test: attempt an untrusted suppression");
  assert.throws(() => main({ ...f.environment(), BETTERLEAKS_CONFIG_TOML: allow(".*") }), /secret scan failed/);
  assert.deepEqual(readdirSync(f.temporary), []);
});

test("a head-only allowlist cannot replace the defaults", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.workspace, ".gitleaks.toml"), allow(".*"));
  writeFileSync(path.join(f.workspace, "token.env"), `credential=${token()}\n`);
  f.git("add", "."); f.git("commit", "-qm", "test: add an untrusted policy");
  assert.throws(() => main(f.environment()), /secret scan failed/);
  assert.deepEqual(readdirSync(f.temporary), []);
});

test("a base allowlist without an extend table still scans with the default rules", (t) => {
  const value = token(); const f = fixture(t, `[allowlist]\nregexes = ['${value}']\n`);
  writeFileSync(path.join(f.workspace, "fixture.env"), `credential=${value}\n`);
  f.git("add", "."); f.git("commit", "-qm", "test: add the allowed fixture");
  main(f.environment());
  writeFileSync(path.join(f.workspace, "token.env"), `credential=${token()}\n`);
  f.git("add", "."); f.git("commit", "-qm", "test: add a new finding");
  assert.throws(() => main(f.environment()), /secret scan failed/);
  assert.deepEqual(readdirSync(f.temporary), []);
});

test("a base policy that drops the default rules fails before a scan", (t) => {
  for (const policy of ["[extend]\nuseDefault = false\n", "[extend]\ndisabledRules = []\n"]) {
    const f = fixture(t, policy);
    assert.throws(() => main(f.environment()), /keep the default rules/);
    assert.deepEqual(readdirSync(f.temporary), []);
  }
});

test("malformed and mutable extended policies fail before a scan", (t) => {
  for (const policy of ["not [valid", '[extend]\npath = "head-policy.toml"\n', '[extend]\nurl = "https://example.test/policy.toml"\n']) {
    const f = fixture(t, policy);
    assert.throws(() => main(f.environment()), /valid self-contained TOML/);
    assert.deepEqual(readdirSync(f.temporary), []);
  }
});

test("invalid UTF-8 and oversized base blobs refuse without an output policy", (t) => {
  for (const policy of [Buffer.from([0xff]), "#" + "a".repeat(65 * 1024)]) {
    const f = fixture(t, policy);
    assert.throws(() => main(f.environment()), /unavailable or exceeds its bound/);
    assert.deepEqual(readdirSync(f.temporary), []);
  }
});
