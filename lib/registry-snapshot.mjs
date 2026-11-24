import { createHash } from "node:crypto";

export const maximumSnapshotBytes = 1024 * 1024;
const fullCommit = /^[0-9a-f]{40}$/;
const hash = /^[0-9a-f]{64}$/;

export function requireRegistryIdentity(commit, digest) {
  if (!fullCommit.test(commit ?? "") || !hash.test(digest ?? "")) {
    throw new Error("Protected registry commit or digest is missing or invalid.");
  }
}

export function verifyRegistrySnapshot(bytes, commit, digest) {
  requireRegistryIdentity(commit, digest);
  if (!bytes.length || bytes.length > maximumSnapshotBytes) {
    throw new Error("Protected registry snapshot is missing or oversized.");
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
}
