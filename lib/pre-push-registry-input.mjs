import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { maximumSnapshotBytes, requireRegistryIdentity, verifyRegistrySnapshot } from "./registry-snapshot.mjs";

function readSnapshot(file) {
  if (!lstatSync(file).isFile()) {
    throw new Error("Protected registry input must be a regular file.");
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > maximumSnapshotBytes) {
      throw new Error("Protected registry input must be a bounded regular file.");
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const length = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!length) throw new Error("Protected registry input changed while reading.");
      offset += length;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function requireRegistryLockPath(lock) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._/-]*\.json$/.test(lock ?? "") ||
      path.posix.normalize(lock) !== lock || lock.split("/").includes("..")) {
    throw new Error("Protected pre-push verification needs a tracked registry lock path.");
  }
}

// The admission service supplies the expected identity. The candidate only selects a commit.
export function prePushRegistryInput(environment, readLock, temporary) {
  const {
    NDDEV_CI_PRE_PUSH_REGISTRY_LOCK: lock,
    NDDEV_CI_PRE_PUSH_REGISTRY_COMMIT: commit,
    NDDEV_CI_PRE_PUSH_REGISTRY_SHA256: digest,
    NDDEV_CI_REGISTRY_SNAPSHOT: source,
  } = environment;
  if ([lock, commit, digest].every((value) => value === undefined)) return {};

  requireRegistryIdentity(commit, digest);
  requireRegistryLockPath(lock);
  if (!source || !path.isAbsolute(source)) {
    throw new Error("Protected pre-push verification needs a job registry snapshot.");
  }
  const lockBytes = readLock(lock);
  let selection;
  try {
    selection = JSON.parse(lockBytes);
  } catch {
    throw new Error("The candidate registry lock is not valid JSON.");
  }
  if (selection?.schema_version !== 1 || selection.registry_commit !== commit) {
    throw new Error("The candidate lock differs from the selected protected registry commit.");
  }

  const bytes = readSnapshot(source);
  verifyRegistrySnapshot(bytes, commit, digest);
  const file = path.join(temporary, "registry.json");
  writeFileSync(file, bytes, {flags: "wx", mode: 0o400});
  return {NDDEV_CI_REGISTRY_SNAPSHOT: file};
}
