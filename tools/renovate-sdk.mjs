// Both generated forms come from one definition; unrelated repository settings stay owned there.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sdkPreset, selfConfiguration, isSelfSdkManager } from "../lib/renovate-sdk.mjs";

const mode = process.argv[2];
if (!["--check", "--write"].includes(mode) || process.argv.length !== 3) {
  throw new Error("usage: node tools/renovate-sdk.mjs --check|--write");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const presetPath = path.join(root, "renovate-sdk-inputs.json");
const selfPath = path.join(root, "renovate.json");
const read = (file) => {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
};
const format = (value) => `${JSON.stringify(value, null, 2)}\n`;
const oldPreset = read(presetPath);
const oldSelf = read(selfPath);
const current = oldSelf === undefined
  ? { $schema: "https://docs.renovatebot.com/renovate-schema.json" }
  : JSON.parse(oldSelf);
// Validate both outputs before writing either one.
const expectedSelf = selfConfiguration(current);
const expectedPreset = format(sdkPreset());
const owned = current.customManagers?.filter(isSelfSdkManager);
const selfFresh = owned?.length === 1 &&
  JSON.stringify(owned[0]) === JSON.stringify(expectedSelf.customManagers.find(isSelfSdkManager));
const changed = [
  oldPreset !== expectedPreset && "renovate-sdk-inputs.json",
  !selfFresh && "renovate.json SDK block",
].filter(Boolean);
if (mode === "--check" && changed.length) {
  throw new Error(`Generated SDK configuration differs: ${changed.join(", ")}. Run just fix.`);
}
if (mode === "--write") {
  if (oldPreset !== expectedPreset) writeFileSync(presetPath, expectedPreset);
  if (!selfFresh) writeFileSync(selfPath, format(expectedSelf));
}
