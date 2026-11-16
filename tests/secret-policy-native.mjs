import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
