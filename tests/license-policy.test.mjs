import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/security.yml", import.meta.url), "utf8");
const defaults = workflow.match(/^      LICENSES: (.+)$/m)[1];
const script = workflow.split("      - name: Licence policy\n")[1].split("        run: |\n")[1]
  .split("      - name:")[0].split("\n").map((line) => line.replace(/^          /, "")).join("\n");

function run(content) {
  const root = mkdtempSync(path.join(tmpdir(), "license-policy-"));
  try {
    if (content !== undefined) writeFileSync(path.join(root, "deny.toml"), content);
    const output = path.join(root, "outputs");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {cwd: root, encoding: "utf8",
      env: {...process.env, POLICY: content === undefined ? "" : "deny.toml", LICENSES: defaults, GITHUB_OUTPUT: output}});
    assert.ifError(result.error);
    const text = existsSync(output) ? readFileSync(output, "utf8") : "";
    const outputs = Object.fromEntries(text.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    return {...result, output: text, outputs};
  } finally { rmSync(root, {recursive: true, force: true}); }
}

test("the actual workflow passes the complete default list without admitting LGPL or GPL", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.outputs.licenses.includes(" WITH "));
  assert.equal(result.outputs.allowed, defaults);
  const list = defaults.split(",");
  for (const license of ["MIT-0", "0BSD", "Apache-2.0 WITH LLVM-exception", "CDLA-Permissive-2.0", "MPL-2.0", "EPL-2.0", "Unlicense"])
    assert.ok(list.includes(license));
  assert.ok(!list.some((license) => /^(?:A?GPL|LGPL)-/.test(license)));
  for (const license of list.filter((item) => !item.includes(" WITH ")))
    assert.ok(result.outputs.licenses.split(",").includes(license));
});

test("a redundant SPDX exception preserves the independently allowed base license", () => {
  const result = run('[licenses]\nallow = ["MIT", "Apache-2.0", "Apache-2.0 WITH LLVM-exception"]\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs.licenses, "MIT,Apache-2.0");
  assert.equal(result.outputs.allowed, "MIT,Apache-2.0,Apache-2.0 WITH LLVM-exception");
});

test("invalid, duplicate and newline-bearing policies fail instead of selecting defaults", () => {
  for (const allow of ['[]', '["MIT", "MIT"]', '["MIT\\nISC"]', '["MIT WITH"]', '["MIT OR Apache-2.0"]', '["Apache-2.0 WITH LLVM-exception"]']) {
    const result = run(`[licenses]\nallow = ${allow}\n`);
    assert.notEqual(result.status, 0, allow);
    assert.equal(result.output, "");
  }
});

// Execute the report's real Python and the policy output selected by its actual env wiring.
const reportScript = workflow.split("python3 - \"$RUNNER_TEMP/security/out\" > \"$RUNNER_TEMP/security/report.md\" <<'PY'\n")[1]
  .split("\n          PY")[0].split("\n").map((line) => line.replace(/^          /, "")).join("\n");
const reportOutput = workflow.match(/^          ALLOWED: \$\{\{ steps\.licences\.outputs\.(\w+) \}\}$/m)[1];
function report(content, entries) {
  const policy = run(content);
  assert.equal(policy.status, 0, policy.stderr);
  const root = mkdtempSync(path.join(tmpdir(), "license-report-"));
  try {
    if (content !== undefined) writeFileSync(path.join(root, "deny.toml"), content);
    for (const [name, value] of Object.entries({"trufflehog.jsonl": "", "kingfisher.json": "{}", "osv.json": "{}",
      "licenses.json": JSON.stringify({results: [{source: {path: "Cargo.lock"}, packages: entries.map(([name, license]) => ({
        package: {ecosystem: "crates.io", name, version: "1.0.0"}, licenses: [license], license_violations: [license],
      }))}]})})) writeFileSync(path.join(root, name), value);
    const result = spawnSync("python3", ["-I", "-", root], {cwd: root, input: reportScript, encoding: "utf8",
      env: {...process.env, ALLOWED: policy.outputs[reportOutput], POLICY: content === undefined ? "" : "deny.toml", RUN: "fixture run"}});
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const findings = JSON.parse(readFileSync(path.join(root, "security-report.json"), "utf8")).findings;
    return {text: result.stdout, findings: findings.filter((row) => row.kind === "license" && row.identifier !== "UNKNOWN").length};
  } finally { rmSync(root, {recursive: true, force: true}); }
}

test("the actual security report accepts the default WITH expression and retains real violations and unknowns", () => {
  const result = report(undefined, [["target-lexicon", "Apache-2.0 WITH LLVM-exception"], ["academic-license", "NCSA"], ["data-license", "CC-BY-4.0"], ["restricted", "GPL-3.0-only"], ["unknown", "UNKNOWN"]]);
  assert.equal(result.findings, 1);
  assert.ok(!result.text.includes("target-lexicon"));
  assert.ok(!result.text.includes("academic-license"));
  assert.ok(!result.text.includes("data-license"));
  assert.ok(result.text.includes("restricted"));
  assert.match(result.text, /1 packages have no licence/);
});

test("the actual security report keeps custom WITH choices and package exceptions scoped", () => {
  const result = report('[licenses]\nallow = ["Apache-2.0", "Apache-2.0 WITH LLVM-exception"]\n[[licenses.exceptions]]\nname = "special"\nallow = ["LGPL-2.1-only"]\n',
    [["accepted", "Apache-2.0 WITH LLVM-exception"], ["different-exception", "Apache-2.0 WITH Classpath-exception-2.0"], ["special", "LGPL-2.1-only"], ["other", "LGPL-2.1-only"]]);
  assert.equal(result.findings, 2);
  assert.ok(!result.text.includes("crates.io accepted"));
  assert.ok(!result.text.includes("crates.io special"));
  assert.ok(result.text.includes("different-exception"));
  assert.ok(result.text.includes("crates.io other"));
});

test("a custom project policy still controls the recognized default identifiers", () => {
  const result = report('[licenses]\nallow = ["MIT"]\n', [["academic-license", "NCSA"], ["data-license", "CC-BY-4.0"]]);
  assert.equal(result.findings, 2);
  assert.ok(result.text.includes("academic-license"));
  assert.ok(result.text.includes("data-license"));
});
