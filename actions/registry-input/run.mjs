import { appendFileSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { maximumSnapshotBytes, requireRegistryIdentity, verifyRegistrySnapshot } from "../../lib/registry-snapshot.mjs";

const chunks = ["FIRST", "SECOND", "THIRD", "FOURTH"];

export function snapshot(environment) {
  const commit = environment.INPUT_COMMIT;
  const digest = environment.INPUT_SHA256;
  requireRegistryIdentity(commit, digest);
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
    bytes = gunzipSync(compressed, { maxOutputLength: maximumSnapshotBytes });
  } catch {
    throw new Error("Protected registry snapshot compression is invalid or oversized.");
  }
  verifyRegistrySnapshot(bytes, commit, digest);
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
  catch (error) {
    if (process.env.GITHUB_OUTPUT) {
      const reason = /commit or digest/i.test(String(error.message ?? ""))
        ? "missing-registry-snapshot-identity"
        : "registry-snapshot-invalid";
      appendFileSync(process.env.GITHUB_OUTPUT, `failure-reason=${reason}\n`);
    }
    console.error("::error::" + error.message);
    process.exitCode = 1;
  }
}
