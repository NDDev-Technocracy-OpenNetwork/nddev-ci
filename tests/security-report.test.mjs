import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hostedSecurityToolPins } from "../lib/hosted-compat-pins.mjs";

const workflow = readFileSync(new URL("../.github/workflows/security.yml", import.meta.url), "utf8");
const script = workflow.split("      - name: Report\n")[1].split("        run: |\n")[1]
  .split("      - name:")[0].split("\n").map((line) => line.replace(/^          /, "")).join("\n");

const hostedPins = hostedSecurityToolPins({ RUNNER_ENVIRONMENT: "github-hosted" });
const scannerVersions = {
  TRUFFLEHOG_VERSION: hostedPins.trufflehog.version,
  KINGFISHER_VERSION: hostedPins.kingfisher.version,
  OSV_SCANNER_VERSION: hostedPins["osv-scanner"].version,
  SYFT_VERSION: hostedPins.syft.version,
  GRYPE_VERSION: hostedPins.grype.version,
  TRIVY_VERSION: hostedPins.trivy.version,
};

function report(files = {}, extraEnv = {}) {
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
    const result = spawnSync("bash", ["-euo", "pipefail", "-s"], {cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, input: script,
      env: {...process.env, ...scannerVersions, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: root, PRIVATE: "false", ALLOWED: "MIT", POLICY: "", RUN: "https://example.test/run/1", GITHUB_STEP_SUMMARY: summary, ...extraEnv}});
    assert.ifError(result.error);
    const jsonFile = path.join(out, "security-report.json");
    const structured = result.stdout.split("::group::Structured security report\n")[1]?.split("\n::endgroup::")[0] ?? null;
    return {...result, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
      structured: structured ? JSON.parse(structured) : null,
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

test("the report includes scanner versions, finding counts and structured JSON in the job log", () => {
  const result = report({"osv.json": osv([{id: "GHSA-001", database_specific: {severity: "MEDIUM"}}])}, {PRIVATE: "true"});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.structured["event.name"], "nddev_ci.security.report");
  assert.deepEqual(result.structured, result.report);
  assert.deepEqual(result.structured.counts, {
    secrets: 0, vulnerabilities: 1, licenses_outside_policy: 0, licenses_unknown: 0, total: 1,
  });
  assert.equal(result.structured.scanners.TruffleHog, scannerVersions.TRUFFLEHOG_VERSION);
  assert.equal(result.structured.scanners.Trivy, scannerVersions.TRIVY_VERSION);
  assert.match(result.summary, /Findings: 1 total \(0 live secrets, 1 vulnerabilities, 0 licences outside policy, 0 unknown licences\)\./);
  assert.match(result.summary, new RegExp(`Scanners: TruffleHog ${scannerVersions.TRUFFLEHOG_VERSION.replaceAll(".", "\\.")}`));
});

test("the job summary stays strictly within 1 MiB of UTF-8 bytes even for oversized findings", () => {
  const wide = "Ж".repeat(40000);
  const items = Array.from({length: 20}, (_, i) => ({id: `GHSA-${String(i).padStart(3, "0")}-${wide}`}));
  for (const [isPrivate, expected] of [["true", /in the run log\./], ["false", /in the artifact and run log\./]]) {
    const result = report({"osv.json": osv(items)}, {PRIVATE: isPrivate});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.summary, "utf8") <= 1024 * 1024, "summary exceeds 1 MiB");
    assert.match(result.summary, expected);
    if (isPrivate === "true") assert.doesNotMatch(result.summary, /in the artifact/);
    assert.match(result.summary, /Findings: 20 total/);
    assert.equal(result.structured.findings.length, 20);
  }
  const giantSingle = report({"osv.json": osv([{id: `GHSA-SINGLE-${"Ж".repeat(600000)}`}])}, {PRIVATE: "true"});
  assert.equal(giantSingle.status, 0, giantSingle.stderr);
  assert.ok(Buffer.byteLength(giantSingle.summary, "utf8") <= 1024 * 1024, "single-line summary exceeds 1 MiB");
  assert.match(giantSingle.summary, /Findings: 1 total/);
  assert.match(giantSingle.summary, /in the run log\./);
});

test("the workflow has no issue writer and uploads the report artifact only for public repositories", () => {
  assert.doesNotMatch(workflow, /issues:\s*write|gh issue\s/);
  assert.doesNotMatch(workflow.split("      - name: Report\n")[1].split("      - name:")[0], /GH_TOKEN:|REPOSITORY:/);
  const uploadStep = workflow.split("      - name: Keep the security report\n")[1].split("      - name:")[0];
  assert.match(uploadStep, /if: \$\{\{ !github\.event\.repository\.private \}\}/);
  assert.match(uploadStep, /name: security-report-\$\{\{ github\.run_attempt \}\}/);
  assert.match(uploadStep, /path: \$\{\{ runner\.temp \}\}\/security\/out\/security-report\.json/);
  assert.match(uploadStep, /retention-days: 14/);
});
