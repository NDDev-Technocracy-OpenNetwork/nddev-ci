import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  hostedBetterleaksVersion,
  hostedImageBuilderPin,
  hostedJustPin,
  hostedMergeStopPins,
  hostedOsvScannerPins,
  hostedSecurityToolPins,
} from "../lib/hosted-compat-pins.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

function walk(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, results);
    else results.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return results;
}

const reusableWorkflows = [
  ".github/workflows/check.yml",
  ".github/workflows/recipe.yml",
  ".github/workflows/merge-stops.yml",
  ".github/workflows/security.yml",
  ".github/workflows/image.yml",
  ".github/workflows/nextest-shards.yml",
  ".github/workflows/promote.yml",
  ".github/workflows/release.yml",
  ".github/workflows/image-tag.yml",
  ".github/workflows/merge-on-green.yml",
  ".github/workflows/registry.yml",
  ".github/workflows/provenance.yml",
  ".github/workflows/source-version.yml",
  ".github/workflows/select-registry-input.yml",
];

test("reusable library files hold zero hardcoded tool/SDK/image versions or binary SHA-256 digests", () => {
  assert.equal(existsSync(path.join(root, "actions/recipe/just.json")), false, "actions/recipe/just.json must be removed");

  const actionFiles = walk(path.join(root, "actions")).filter((rel) => /\.(yml|yaml|mjs|json)$/.test(rel));
  const libFiles = walk(path.join(root, "lib"))
    .filter((rel) => rel.endsWith(".mjs") && rel !== "lib/hosted-compat-pins.mjs");

  const forbiddenPatterns = [
    [/^\s*(?:TRUFFLEHOG|KINGFISHER|OSV_SCANNER|SYFT|GRYPE|TRIVY|BETTERLEAKS|POUTINE|ACTIONLINT|ZIZMOR|COMMITTED|SHELLCHECK|JSCPD)_(?:VERSION|SHA256_[A-Z0-9]+):\s*["']?[0-9a-f]/m, "hardcoded tool version or SHA-256 env pin"],
    [/^\s*version:\s*v?\d+\.\d+\.\d+\s*$/m, "hardcoded action tool version input"],
    [/moby\/buildkit:v?\d+\.\d+\.\d+@sha256:[0-9a-f]{64}/, "hardcoded BuildKit image pin"],
    [/\bbetterleaksVersion\s*=\s*["']\d+\.\d+\.\d+["']/, "hardcoded betterleaks version constant"],
    [/\bscannerPins\s*=\s*Object\.freeze/, "hardcoded osv-scanner pins outside hosted-compat-pins.mjs"],
  ];

  for (const rel of [...reusableWorkflows, ...actionFiles, ...libFiles]) {
    const content = read(rel);
    for (const [pattern, label] of forbiddenPatterns) {
      assert.doesNotMatch(content, pattern, `${rel} contains ${label}`);
    }
  }
});

test("every preparation reusable workflow receives protected registry input ahead of preparation", () => {
  for (const wf of [
    ".github/workflows/check.yml",
    ".github/workflows/recipe.yml",
    ".github/workflows/merge-stops.yml",
    ".github/workflows/security.yml",
    ".github/workflows/image.yml",
    ".github/workflows/image-tag.yml",
    ".github/workflows/nextest-shards.yml",
  ]) {
    const text = read(wf);
    assert.match(text, /^      registry-commit:$/m, `${wf} declares registry-commit`);
    assert.match(text, /^      REGISTRY_SNAPSHOT_FIRST:$/m, `${wf} declares REGISTRY_SNAPSHOT_FIRST secret`);
    assert.match(text, /environment:\s*\$\{\{ inputs\.registry-commit != '' && format\('registry-input-\{0\}', inputs\.registry-commit\) \|\| '' \}\}/, `${wf} binds registry-input environment`);
  }

  // Inside actions/prepare, registry-input runs strictly ahead of frontend, hosted-sdk and image-builder.
  const prepare = read("actions/prepare/action.yml");
  const regPos = prepare.indexOf("uses: $/actions/registry-input");
  assert.notEqual(regPos, -1, "actions/prepare invokes $/actions/registry-input");
  for (const target of ["uses: $/actions/frontend", "uses: $/actions/hosted-sdk", "uses: $/actions/image-builder"]) {
    const targetPos = prepare.indexOf(target);
    assert.ok(regPos < targetPos, `actions/prepare must run registry-input before ${target}`);
  }

  // In merge-stops, security and image workflows, registry-input runs strictly ahead of tool/builder setup.
  for (const [wf, beforeTarget] of [
    [".github/workflows/merge-stops.yml", "uses: $/actions/merge-stops"],
    [".github/workflows/security.yml", "uses: $/actions/security-tools"],
    [".github/workflows/image.yml", "uses: $/actions/image-builder"],
  ]) {
    const text = read(wf);
    const regPosWf = text.indexOf("uses: $/actions/registry-input");
    const nextPos = text.indexOf(beforeTarget);
    assert.ok(regPosWf !== -1 && nextPos !== -1 && regPosWf < nextPos, `${wf} must run registry-input before ${beforeTarget}`);
  }
});

test("managed runners are strictly blocked from reading hosted compatibility pins", () => {
  const managedEnv = { RUNNER_ENVIRONMENT: "self-hosted" };
  for (const fn of [
    hostedJustPin,
    hostedOsvScannerPins,
    hostedMergeStopPins,
    hostedSecurityToolPins,
    hostedImageBuilderPin,
    hostedBetterleaksVersion,
  ]) {
    assert.throws(() => fn(managedEnv), /Managed runners cannot read hosted compatibility pins/);
  }
});
