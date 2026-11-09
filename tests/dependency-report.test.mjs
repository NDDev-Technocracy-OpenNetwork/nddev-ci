import assert from "node:assert/strict";
import test from "node:test";
import { findings, compareReports } from "../lib/dependency-report.mjs";

function report({ id = "GHSA-test", alias = "CVE-2099-0001", name = "example", version = "1.0.0", severity = "9.8", fixed = "2.0.0", file = "/head/package-lock.json" } = {}) {
  return { results: [{ source: { type: "lockfile", path: file }, packages: [{ package: { name, version, ecosystem: "npm" }, vulnerabilities: [{ id, aliases: [alias], affected: [{ package: { name, ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, ...(fixed === null ? [] : [{ fixed }])] }] }] }], groups: [{ ids: [id], aliases: [id, alias], max_severity: severity }] }] }] };
}
const parse = (value, root = "/head", file = "package-lock.json") => findings(value, root, [file]);
const empty = () => ({ packages: 0, findings: [] });

test("a newly introduced critical vulnerability with an advisory fix stops the comparison", () => {
  const value = compareReports(empty(), parse(report()));
  assert.equal(value.introduced.length, 1);
  assert.deepEqual(value.introduced[0].fixed, ["2.0.0"]);
});
test("preexisting aliases remain diagnostic across package version and advisory identifier changes", () => {
  const old = parse(report({ id: "OSV-old", file: "/base/package-lock.json" }), "/base");
  const head = parse(report({ id: "GHSA-new", version: "1.1.0" }));
  const value = compareReports(old, head);
  assert.equal(value.introduced.length, 0);
  assert.equal(value.diagnostics.preexisting, 1);
});
test("high severity, unknown severity and critical findings without a fix remain visible diagnostics", () => {
  for (const [fields, count] of [[{ severity: "8.9" }, "noncritical"], [{ severity: "" }, "unknownSeverity"], [{ fixed: null }, "criticalWithoutFix"]]) {
    const value = compareReports(empty(), parse(report(fields)));
    assert.equal(value.introduced.length, 0);
    assert.equal(value.diagnostics[count], 1);
  }
});
test("a fix for a different package or ecosystem cannot satisfy the guard", () => {
  for (const change of [{ name: "other" }, { ecosystem: "PyPI" }]) {
    const value = report();
    Object.assign(value.results[0].packages[0].vulnerabilities[0].affected[0].package, change);
    assert.equal(compareReports(empty(), parse(value)).introduced.length, 0);
  }
});
test("independent lockfile scopes are compared separately and explicit Git renames preserve existing findings", () => {
  const old = parse(report({ file: "/base/old/package-lock.json" }), "/base", "old/package-lock.json");
  const head = parse(report({ file: "/head/new/package-lock.json" }), "/head", "new/package-lock.json");
  assert.equal(compareReports(old, head).introduced.length, 1);
  assert.equal(compareReports(old, head, new Map([["old/package-lock.json", "new/package-lock.json"]])).introduced.length, 0);
});
test("malformed reports, missing severity and inputs from another source fail rather than imply a clean scan", () => {
  const cases = [null, {}, { results: null }, report({ file: "/other/package-lock.json" }), report({ severity: "CRITICAL" }), report({ severity: "11" })];
  const missing = report(); delete missing.results[0].packages[0].groups[0].max_severity; cases.push(missing);
  const ungrouped = report(); delete ungrouped.results[0].packages[0].groups; cases.push(ungrouped);
  for (const value of cases) assert.throws(() => parse(value));
});
test("clean packages still count and deleting a vulnerable dependency introduces no finding", () => {
  const clean = report(); delete clean.results[0].packages[0].vulnerabilities; delete clean.results[0].packages[0].groups;
  const value = parse(clean);
  assert.equal(value.packages, 1); assert.equal(value.findings.length, 0);
  assert.equal(compareReports(parse(report()), value).introduced.length, 0);
});
