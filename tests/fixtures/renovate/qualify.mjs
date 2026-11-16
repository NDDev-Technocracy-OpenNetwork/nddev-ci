import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sdkInputs, sdkDepType } from "./definition.mjs";

const engine = "/usr/local/renovate/dist/";
const { GlobalConfig } = await import(engine + "config/global.js");
const { getConfig } = await import(engine + "config/defaults.js");
const { getManagerConfig, mergeChildConfig } = await import(engine + "config/index.js");
const { resolveConfigPresets } = await import(engine + "config/presets/index.js");
const { extractPackageFile } = await import(engine + "modules/manager/index.js");
const { getMatchingFiles } = await import(engine + "workers/repository/extract/file-match.js");
const { doAutoReplace } = await import(engine + "workers/repository/update/branch/auto-replace.js");
const { validateConfig } = await import(engine + "config/validation.js");
const memory = await import(engine + "util/cache/memory/index.js");
const source = JSON.parse(fs.readFileSync("/fixture/source.json", "utf8"));
assert.equal(JSON.parse(fs.readFileSync("/usr/local/renovate/package.json", "utf8")).version, source.version);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-qualification-"));
fs.mkdirSync(path.join(directory, ".github/workflows"), { recursive: true });
GlobalConfig.set({ ...getConfig(), localDir: directory, platform: "github", presetCachePersistence: false });
memory.init();
const file = ".github/workflows/ci.yml";
const reference = `github>${source.repository}:renovate-sdk-inputs#${source.revision}`;
// Native GitHub preset loading performs the real public Contents API read at this exact commit.
// There is no seeded preset cache, source-loader replacement or credential input.
const { config: consumer } = await resolveConfigPresets({ extends: [reference] });
const self = JSON.parse(fs.readFileSync("/fixture/self.json", "utf8"));
const localPreset = JSON.parse(fs.readFileSync("/fixture/preset.json", "utf8"));
const fq = "NDDev-Technocracy-OpenNetwork/nddev-ci/.github/workflows/check.yml@" + "a".repeat(40);
const relative = "./.github/workflows/check.yml";
const yaml = (uses, key, value) => `jobs:\n  check:\n    uses: ${uses}\n    with:\n      ${key}: ${value}\n`;

async function dependencies(content, config) {
  const result = [];
  for (const custom of config.customManagers ?? []) {
    const manager = mergeChildConfig(getManagerConfig(getConfig(), custom.customType), custom);
    manager.manager = custom.customType;
    if (!getMatchingFiles(manager, [file]).length) continue;
    const found = await extractPackageFile(custom.customType, content, file, manager);
    for (const [index, dep] of (found?.deps ?? []).entries()) {
      dep.packageName ??= dep.depName;
      if (dep.depType === sdkDepType) result.push({ manager, found, dep, index });
    }
  }
  return result;
}
async function update(content, config, next = "1.2.4") {
  let changed = content;
  const initial = await dependencies(content, config);
  for (let index = 0; index < initial.length; index++) {
    const item = (await dependencies(changed, config))[index];
    changed = await doAutoReplace({ ...getConfig(), ...item.manager, ...item.found, ...item.dep, manager: item.manager.manager, packageFile: file, depIndex: item.index, newValue: next }, changed, false);
    assert.equal(typeof changed, "string");
  }
  return { content: changed, count: initial.length };
}

test("resolves the published preset at the checkout revision and validates both generated configurations", async () => {
  assert.equal(createHash("sha256").update(fs.readFileSync("/fixture/preset.json")).digest("hex"), source.presetSha256);
  assert.deepEqual(consumer.customManagers, localPreset.customManagers);
  for (const config of [consumer, self]) {
    const checked = await validateConfig("config", config);
    assert.deepEqual(checked.errors, []);
    assert.deepEqual(checked.warnings, []);
  }
  console.log(JSON.stringify({ repository: source.repository, revision: source.revision, presetSha256: source.presetSha256, renovate: source.version }));
});
for (const key of Object.keys(sdkInputs)) {
  for (const [label, uses, config] of [["qualified", fq, consumer], ["relative", relative, self]]) {
    test(`${key}: native extraction and replacement in ${label} calls`, async () => {
      const content = yaml(uses, key, "'1.2.3'");
      const found = await dependencies(content, config);
      assert.equal(found.length, 1);
      for (const [field, value] of Object.entries(sdkInputs[key])) assert.equal(found[0].dep[field], value);
      const changed = await update(content, config);
      assert.equal(changed.count, 1);
      assert.equal(changed.content, content.replace("'1.2.3'", "'1.2.4'"));
    });
  }
}
for (const [label, content, config] of [
  ["foreign relative workflow", yaml(relative, "rust-version", "'1.2.3'"), consumer],
  ["foreign qualified workflow", yaml("other/library/.github/workflows/check.yml@v1", "rust-version", "'1.2.3'"), consumer],
  ["unrelated local path", yaml("./other/check.yml", "rust-version", "'1.2.3'"), self],
  ["expression", yaml(relative, "rust-version", "${{ inputs.rust-version }}"), self],
  ["nonliteral scalar", yaml(relative, "rust-version", "42"), self],
  ["ambiguous duplicate key", yaml(relative, "rust-version", "'1.2.3'") + "      rust-version: '1.2.4'\n", self],
]) {
  test(`${label} stays unchanged`, async () => {
    const changed = await update(content, config);
    assert.equal(changed.count, 0);
    assert.equal(changed.content, content);
  });
}
test("self repository syntax and action calls retain their public SDK meaning", async () => {
  for (const uses of ["$/.github/workflows/check.yml", "./actions/prepare", "$/actions/hosted-sdk"]) {
    const content = yaml(uses, "rust-version", "'1.2.3'");
    assert.equal((await update(content, self)).content, content.replace("'1.2.3'", "'1.2.4'"));
  }
});
test("replacement selects the owned call without touching equal foreign values or comments", async () => {
  const content = ["jobs:", "  foreign:", "    uses: other/library/.github/workflows/check.yml@v1", "    with:", "      rust-version: '1.2.3' # foreign", "  ours:", "    with:", "      rust-version: '1.2.3' # owned", `    uses: ${fq}`, ""].join("\n");
  assert.equal((await update(content, consumer)).content, content.replace("'1.2.3' # owned", "'1.2.4' # owned"));
});
test("an aliased version shared with a foreign call is not silently rewritten", async () => {
  const content = ["sdk: &sdk", "  rust-version: '1.2.3'", "jobs:", "  foreign:", "    uses: other/library/.github/workflows/check.yml@v1", "    with: *sdk", "  ours:", `    uses: ${fq}`, "    with: *sdk", ""].join("\n");
  let changed;
  try { changed = await update(content, consumer); }
  catch (error) { assert.match(error.message, /file-update-failed/); return; }
  assert.equal(changed.content, content, "an indirect shared value is not a literal SDK input");
});
process.on("exit", () => { fs.rmSync(directory, { recursive: true, force: true }); memory.reset(); });
