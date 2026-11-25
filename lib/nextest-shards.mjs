// Validation and command builders for opt-in cargo-nextest archive + shard runs.
// Uses modern slice/hash partitioning and rejects the deprecated count partitioner.

const ALLOWED_STRATEGIES = new Set(["slice", "hash"]);
const SAFE_PROFILE = /^[A-Za-z0-9._-]{1,64}$/;
export const MIN_SHARDS = 2;
export const MAX_SHARDS = 16;

export function parseStringArrayInput(raw, name) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0 || /[\0\r\n]/.test(item))) {
    throw new Error(`${name} must be a JSON array of non-empty single-line strings.`);
  }
  return parsed;
}

export function validateShardConfig({ shards, strategy = "slice", profile = "" } = {}) {
  const count = Number(shards);
  if (!Number.isInteger(count) || count < MIN_SHARDS || count > MAX_SHARDS) {
    throw new Error(`shards must be an integer between ${MIN_SHARDS} and ${MAX_SHARDS}.`);
  }
  const normalizedStrategy = String(strategy || "slice").trim();
  if (normalizedStrategy === "count") {
    throw new Error('partition-strategy "count" is deprecated by cargo-nextest; use "slice" or "hash".');
  }
  if (!ALLOWED_STRATEGIES.has(normalizedStrategy)) {
    throw new Error('partition-strategy must be "slice" or "hash".');
  }
  const normalizedProfile = String(profile ?? "").trim();
  if (normalizedProfile && !SAFE_PROFILE.test(normalizedProfile)) {
    throw new Error("nextest-profile must use 1 to 64 safe characters (A-Z, a-z, 0-9, ., _, -).");
  }
  const matrix = [];
  for (let index = 1; index <= count; index += 1) {
    matrix.push({
      shard: index,
      total: count,
      partition: `${normalizedStrategy}:${index}/${count}`,
    });
  }
  return { shards: count, strategy: normalizedStrategy, profile: normalizedProfile, matrix };
}

export function buildArchiveArgs({ archiveFile, extraArgs = [] } = {}) {
  if (!archiveFile || typeof archiveFile !== "string" || /[\0\r\n]/.test(archiveFile)) {
    throw new Error("archiveFile must be a non-empty path.");
  }
  return ["nextest", "archive", "--locked", "--archive-file", archiveFile, ...extraArgs];
}

export function buildRunArgs({ archiveFile, extractTo, partition, profile = "", extraArgs = [] } = {}) {
  if (!archiveFile || typeof archiveFile !== "string" || /[\0\r\n]/.test(archiveFile)) {
    throw new Error("archiveFile must be a non-empty path.");
  }
  if (!partition || !/^(?:slice|hash):\d+\/\d+$/.test(partition)) {
    throw new Error("partition must be slice:m/n or hash:m/n.");
  }
  const args = ["nextest", "run", "--archive-file", archiveFile, "--partition", partition];
  if (extractTo) args.push("--extract-to", extractTo);
  if (profile) {
    if (!SAFE_PROFILE.test(profile)) throw new Error("nextest-profile is invalid.");
    args.push("--profile", profile);
  }
  return [...args, ...extraArgs];
}
