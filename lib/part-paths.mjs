// Fail-safe subtree path filtering for multi-part verify workflows.
// Only skips parts whose declared prefixes are completely untouched when every changed file maps
// to at least one declared prefix and no global, workflow, justfile, lockfile or release-ref edit
// occurred.
import path from "node:path";
import { classifyPathBypass, isArtifactProducingPart, isReleaseRef } from "./step-receipts.mjs";

const GLOBAL_ROOT_FILES = new Set([
  "Cargo.toml",
  "Cargo.lock",
  "package.json",
  "pyproject.toml",
  "pubspec.yaml",
  "go.mod",
  "tsconfig.json",
  "tsconfig.base.json",
  "biome.json",
  "biome.jsonc",
  "deny.toml",
  ".jscpd.json",
  "rust-toolchain",
  "rust-toolchain.toml",
]);

function normalizePath(raw) {
  return String(raw ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function validatePrefix(raw, partName) {
  if (typeof raw !== "string") {
    throw new Error(`part-paths prefix for "${partName}" must be a string.`);
  }
  const normalized = normalizePath(raw.trim());
  if (!normalized) {
    throw new Error(`part-paths prefix for "${partName}" must not be empty.`);
  }
  if (
    normalized.startsWith("/") ||
    normalized.includes("..") ||
    normalized.includes("*") ||
    normalized.includes("?") ||
    /[\0\r\n]/.test(normalized)
  ) {
    throw new Error(`part-paths prefix "${raw}" for "${partName}" must be a plain repository-relative prefix.`);
  }
  return normalized.replace(/\/+$/, "");
}

export function parsePartPaths(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return {};
  let parsed;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("part-paths must be valid JSON.");
    }
  } else {
    parsed = raw;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("part-paths must be a JSON object mapping part group IDs to prefix lists.");
  }
  const normalized = {};
  for (const [group, prefixes] of Object.entries(parsed)) {
    const key = String(group).trim();
    if (!key) throw new Error("part-paths keys must be non-empty part group IDs.");
    if (!Array.isArray(prefixes) || prefixes.length === 0) {
      throw new Error(`part-paths entry for "${key}" must be a non-empty array of path prefixes.`);
    }
    normalized[key] = prefixes.map((entry) => validatePrefix(entry, key));
  }
  return normalized;
}

export function matchesPrefix(filePath, prefix) {
  const file = normalizePath(filePath);
  const cleanPrefix = normalizePath(prefix).replace(/\/+$/, "");
  if (!file || !cleanPrefix) return false;
  if (cleanPrefix === ".") return true;
  return file === cleanPrefix || file.startsWith(`${cleanPrefix}/`);
}

function isGlobalChange(filePath) {
  const file = normalizePath(filePath);
  if (!file) return false;
  if (classifyPathBypass(file)) return true;
  if (!file.includes("/") && GLOBAL_ROOT_FILES.has(path.posix.basename(file))) return true;
  return false;
}

function partKeys(part) {
  const keys = new Set();
  if (part?.group) keys.add(String(part.group));
  if (part?.label) keys.add(String(part.label));
  if (Array.isArray(part?.argv) && part.argv.length > 0) {
    for (const token of part.argv) {
      const value = String(token);
      if (value && !value.startsWith("-")) keys.add(value);
    }
  }
  return [...keys];
}

/**
 * Select which parts of a multi-part verify must run for the changed files.
 * Fails safe (runs every part) whenever the diff is unavailable, empty, on a release ref,
 * touches global/workflow/justfile/lockfile paths, or touches any file outside declared prefixes.
 */
export function selectActiveParts({ parts = [], changedFiles = null, partPaths = {}, ref = "", artifact = "" } = {}) {
  const list = Array.isArray(parts) ? parts : [];
  const mapping = typeof partPaths === "string" ? parsePartPaths(partPaths) : (partPaths ?? {});
  const configuredGroups = Object.keys(mapping);
  if (list.length === 0 || configuredGroups.length === 0) {
    return { activeParts: list, skippedParts: [], reason: "" };
  }
  if (isReleaseRef(ref)) {
    return { activeParts: list, skippedParts: [], reason: "release-ref" };
  }
  if (!Array.isArray(changedFiles)) {
    return { activeParts: list, skippedParts: [], reason: "diff-unavailable" };
  }
  if (changedFiles.length === 0) {
    return { activeParts: list, skippedParts: [], reason: "empty-diff" };
  }

  const allPrefixes = configuredGroups.flatMap((group) => mapping[group]);
  for (const file of changedFiles) {
    if (isGlobalChange(file)) {
      return { activeParts: list, skippedParts: [], reason: "global-change" };
    }
    if (!allPrefixes.some((prefix) => matchesPrefix(file, prefix))) {
      return { activeParts: list, skippedParts: [], reason: "unmapped-file" };
    }
  }

  const activeParts = [];
  const skippedParts = [];
  const keepArtifact = String(artifact ?? "").trim() !== "";

  for (const part of list) {
    const keys = partKeys(part);
    const mappedKeys = keys.filter((key) => Object.hasOwn(mapping, key));
    if (mappedKeys.length === 0) {
      // Any part not declared in part-paths stays active conservatively.
      activeParts.push(part);
      continue;
    }
    if (keepArtifact && isArtifactProducingPart(part)) {
      activeParts.push(part);
      continue;
    }
    const prefixes = mappedKeys.flatMap((key) => mapping[key]);
    const touched = changedFiles.some((file) => prefixes.some((prefix) => matchesPrefix(file, prefix)));
    if (touched) activeParts.push(part);
    else skippedParts.push(part);
  }

  if (activeParts.length === 0) {
    return { activeParts: list, skippedParts: [], reason: "no-active-parts" };
  }
  return { activeParts, skippedParts, reason: skippedParts.length > 0 ? "filtered" : "" };
}
