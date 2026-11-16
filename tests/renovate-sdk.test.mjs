import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sdkDepType, sdkManager, isSelfSdkManager } from "../lib/renovate-sdk.mjs";

function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "renovate-sdk-"));
  for (const file of ["lib/renovate-sdk.mjs", "tools/renovate-sdk.mjs"]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    copyFileSync(new URL(`../${file}`, import.meta.url), path.join(root, file));
  }
  const generate = (mode) => spawnSync(process.execPath, [path.join(root, "tools/renovate-sdk.mjs"), mode], { encoding: "utf8" });
  try { run({ root, generate }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("offline checking refuses stale output without writing, and regeneration preserves unrelated settings", () => fixture(({ root, generate }) => {
  const original = {
    extends: ["config:recommended"],
    labels: ["keep this"],
    customManagers: [{ customType: "regex", depTypeTemplate: sdkDepType, managerFilePatterns: ["custom.txt"], matchStrings: ["unrelated"] }],
  };
  writeFileSync(path.join(root, "renovate.json"), JSON.stringify(original));
  assert.equal(generate("--write").status, 0);
  const preset = path.join(root, "renovate-sdk-inputs.json");
  const config = path.join(root, "renovate.json");
  const generated = JSON.parse(readFileSync(config, "utf8"));
  assert.deepEqual(generated.extends, original.extends);
  assert.deepEqual(generated.labels, original.labels);
  assert.deepEqual(generated.customManagers[0], original.customManagers[0]);
  assert.equal(generated.customManagers.filter(isSelfSdkManager).length, 1);
  assert.equal(generate("--check").status, 0);
  writeFileSync(preset, "{}\n");
  const before = readFileSync(config, "utf8");
  assert.notEqual(generate("--check").status, 0);
  assert.equal(readFileSync(preset, "utf8"), "{}\n");
  assert.equal(readFileSync(config, "utf8"), before);
  assert.equal(generate("--write").status, 0);
  generated.customManagers[1].matchStrings = ["stale"];
  generated.other = { keep: true };
  writeFileSync(config, JSON.stringify(generated));
  assert.notEqual(generate("--check").status, 0);
  assert.equal(generate("--write").status, 0);
  assert.equal(generate("--check").status, 0);
  const repaired = JSON.parse(readFileSync(config, "utf8"));
  assert.deepEqual(repaired.other, { keep: true });
  assert.equal(repaired.customManagers.length, generated.customManagers.length);
  assert.deepEqual(repaired.customManagers[0], original.customManagers[0]);
  assert.deepEqual(repaired.customManagers[1], sdkManager("relative"));
}));

test("ambiguous ownership refuses writes instead of replacing unrelated configuration", () => fixture(({ root, generate }) => {
  const file = path.join(root, "renovate.json");
  const content = JSON.stringify({ customManagers: [sdkManager("relative"), sdkManager("relative")] });
  writeFileSync(file, content);
  const result = generate("--write");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Duplicate generated SDK manager/);
  assert.equal(readFileSync(file, "utf8"), content);
}));
