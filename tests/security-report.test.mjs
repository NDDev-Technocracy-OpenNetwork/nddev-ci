import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/security.yml", import.meta.url), "utf8");
const script = workflow.split("      - name: Report\n")[1].split("        run: |\n")[1]
  .split("      - name:")[0].split("\n").map((line) => line.replace(/^          /, "")).join("\n");

function report(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "security-report-"));
  try {
    const out = path.join(root, "security/out");
    mkdirSync(out, {recursive: true});
    const values = {"trufflehog.jsonl": "", "kingfisher.json": "{}", "osv.json": "{}", "licenses.json": "{}", ...files};
    for (const [name, value] of Object.entries(values)) if (value !== null)
      writeFileSync(path.join(out, name), typeof value === "string" ? value : JSON.stringify(value));
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho unexpected-issue-api >&2\nexit 99\n", {mode: 0o755});
    const summary = path.join(root, "summary.md");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {cwd: root, encoding: "utf8",
      env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: root, ALLOWED: "MIT", POLICY: "", RUN: "https://example.test/run/1", GITHUB_STEP_SUMMARY: summary}});
    assert.ifError(result.error);
    const jsonFile = path.join(out, "security-report.json");
    return {...result, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
      report: existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, "utf8")) : null};
  } finally { rmSync(root, {recursive: true, force: true}); }
}

const packageInfo = {ecosystem: "crates.io", name: "example", version: "1.0.0"};
const osv = (vulnerabilities) => ({results: [{source: {path: "Cargo.lock"}, packages: [{package: packageInfo, vulnerabilities}]}]});

test("the actual report preserves scanner, target, severity and all reported fix versions", () => {
  const result = report({"osv.json": osv([
    {id: "GHSA-fixed", database_specific: {severity: "HIGH"}, affected: [
      {package: packageInfo, ranges: [{type: "SEMVER", events: [{introduced: "0"}, {fixed: "1.0.1"}]}]},
      {package: {...packageInfo, name: "unrelated"}, ranges: [{events: [{fixed: "9.9.9"}]}]},
    ]},
    {id: "GHSA-unfixed", severity: [{type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}]},
  ]), "repository.name": "the repository", "grype-repository.json": {matches: [
    {vulnerability: {id: "CVE-grype", severity: "Critical", fix: {versions: ["2.0.1", "2.1.0"]}}, artifact: {name: "native", version: "2.0.0", type: "deb"}},
  ]}, "trivy-repository.json": {Results: [{Target: "usr/lib/package", Type: "debian", Vulnerabilities: [
    {VulnerabilityID: "CVE-trivy", Severity: "HIGH", PkgName: "native", InstalledVersion: "2.0.0", FixedVersion: "2.0.1, 2.1.0"},
    {VulnerabilityID: "CVE-no-fix", Severity: "LOW", PkgName: "other", InstalledVersion: "3.0.0"},
  ]}]}});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.schema_version, 1);
  assert.equal(result.report.run, "https://example.test/run/1");
  assert.equal(result.report.findings.length, 5);
  const byId = Object.fromEntries(result.report.findings.map((row) => [row.identifier, row]));
  assert.deepEqual(byId["GHSA-fixed"].fixed_versions, ["1.0.1"]);
  assert.equal(byId["GHSA-fixed"].target, "Cargo.lock");
  assert.equal(byId["GHSA-fixed"].severity, "HIGH");
  assert.deepEqual(byId["GHSA-unfixed"].fixed_versions, []);
  assert.equal(byId["GHSA-unfixed"].severity, null);
  assert.equal(byId["GHSA-unfixed"].severity_scores[0].type, "CVSS_V3");
  for (const id of ["CVE-grype", "CVE-trivy"]) assert.deepEqual(byId[id].fixed_versions, ["2.0.1", "2.1.0"]);
  assert.equal(byId["CVE-trivy"].package_target, "usr/lib/package");
  assert.deepEqual(byId["CVE-no-fix"].fixed_versions, []);
  assert.match(result.summary, /CVE-no-fix/);
  assert.doesNotMatch(result.stderr, /unexpected-issue-api/);
});

test("secret and unknown-license metadata is retained without any matched secret value", () => {
  const raw = "secret-value-must-never-be-retained";
  const result = report({"trufflehog.jsonl": JSON.stringify({DetectorName: "Example", Raw: raw, Verified: true,
    SourceMetadata: {Data: {Git: {file: "fixture.txt", line: 7, commit: "abc123"}}}}),
  "kingfisher.json": JSON.stringify({findings: [{rule: {name: "Example2"}, finding: {path: "other.txt", line: 9, secret: raw}}]}),
  "licenses.json": {results: [{source: {path: "Cargo.lock"}, packages: [{package: packageInfo, licenses: ["UNKNOWN"], license_violations: ["UNKNOWN"]}]}]}});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.findings.length, 3);
  assert.equal(result.report.findings.filter((row) => row.kind === "secret" && row.verified === true).length, 2);
  assert.equal(result.report.findings.find((row) => row.scanner === "TruffleHog").commit, "abc123");
  assert.ok(result.report.findings.some((row) => row.kind === "license" && row.identifier === "UNKNOWN"));
  assert.ok(!JSON.stringify(result.report).includes(raw));
  assert.ok(!result.summary.includes(raw));
  assert.match(result.summary, /1 packages have no licence/);
});

test("the bounded summary retains every omitted row in its JSON artifact", () => {
  const result = report({"osv.json": osv(Array.from({length: 55}, (_, i) => ({id: `GHSA-${String(i).padStart(3, "0")}`})))});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.findings.length, 55);
  assert.match(result.summary, /and 5 more/);
  assert.doesNotMatch(result.summary, /GHSA-054/);
  assert.ok(result.report.findings.some((row) => row.identifier === "GHSA-054"));
});

test("missing or malformed scanner output still fails and produces no success report", () => {
  for (const value of [null, "not-json"]) {
    const result = report({"osv.json": value});
    assert.notEqual(result.status, 0);
    assert.equal(result.report, null);
    assert.equal(result.summary, "");
  }
});

test("the workflow has no issue writer and retains the report with its existing upload provider", () => {
  assert.doesNotMatch(workflow, /issues:\s*write|gh issue\s/);
  assert.doesNotMatch(workflow.split("      - name: Report\n")[1].split("      - name:")[0], /GH_TOKEN:|REPOSITORY:/);
  assert.match(workflow, /name: security-report-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/security\/out\/security-report\.json/);
  assert.match(workflow, /retention-days: 14/);
});
