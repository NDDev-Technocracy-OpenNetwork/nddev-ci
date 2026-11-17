import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const chunks = ["FIRST", "SECOND", "THIRD", "FOURTH"];
const fullCommit = /^[0-9a-f]{40}$/;
const hash = /^[0-9a-f]{64}$/;

export function snapshot(environment) {
  const commit = environment.INPUT_COMMIT;
  const digest = environment.INPUT_SHA256;
  if (!fullCommit.test(commit ?? "") || !hash.test(digest ?? "")) {
    throw new Error("Protected registry commit or digest is missing or invalid.");
  }
  const input = chunks.map((name) => environment["INPUT_" + name] || "");
  if (!input[0] || input.some((part) => part.length > 46_000)) {
    throw new Error("Protected registry snapshot is missing or oversized.");
  }
  const armored = input.join("");
  const compressed = Buffer.from(armored, "base64");
  if (compressed.toString("base64") !== armored) {
    throw new Error("Protected registry snapshot encoding is invalid.");
  }
  let bytes;
  try {
    bytes = gunzipSync(compressed, { maxOutputLength: 1024 * 1024 });
  } catch {
    throw new Error("Protected registry snapshot compression is invalid or oversized.");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== digest) {
    throw new Error("Protected registry snapshot differs from its digest.");
  }
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("Protected registry snapshot is not JSON.");
  }
  if (value?.schema_version !== 1 || value.registry_commit !== commit ||
      typeof value.technologies_toml !== "string") {
    throw new Error("Protected registry snapshot differs from the selected source.");
  }
  return bytes;
}

export function main(environment = process.env) {
  const bytes = snapshot(environment);
  const temp = environment.RUNNER_TEMP;
  if (!temp || !isAbsolute(temp) || /[\r\n]/.test(temp) ||
      !environment.GITHUB_ENV || !environment.GITHUB_STATE) {
    throw new Error("Protected registry input needs a job-owned temporary directory.");
  }
  const directory = mkdtempSync(join(temp, "contour-registry-"));
  const path = join(directory, "registry.json");
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o400 });
    appendFileSync(environment.GITHUB_STATE, "registry_snapshot_directory=" + directory + "\n");
    appendFileSync(environment.GITHUB_ENV, "NDDEV_CI_REGISTRY_SNAPSHOT=" + path + "\n");
  } catch (error) {
    try { unlinkSync(path); } catch (cleanup) { if (cleanup.code !== "ENOENT") throw cleanup; }
    rmdirSync(directory);
    throw error;
  }
  console.log("Received protected registry " + environment.INPUT_COMMIT + ".");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); }
  catch (error) { console.error("::error::" + error.message); process.exitCode = 1; }
}
