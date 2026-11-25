// Content-addressed step receipts for reusing verified check outcomes on identical inputs.
// Private self-hosted runners use an HTTP receipt gateway backed by a network cache and verified
// Ed25519 DSSE envelopes; public hosted runners use branch-scoped GitHub Actions cache entries.
import { spawnSync } from "node:child_process";
import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const RECEIPT_SCHEMA = "nddev-ci.step-receipt.v1";
export const DSSE_PAYLOAD_TYPE = "application/vnd.nddev.ci.step-receipt.v1+json";
export const DEFAULT_CACHE_EPOCH = "1";
export const DEFAULT_CANARY_PERCENT = 5;
export const DEFAULT_OIDC_AUDIENCE = "nddev-ci-receipts";
export const TRUSTED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const PR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const EPOCH_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST_HEX_PATTERN = /^[0-9a-f]{64}$/;

const WORKFLOW_PATH_PATTERNS = [/^\.github\/workflows\//, /^\.github\/actions\//];
const JUSTFILE_PATH_PATTERNS = [/(?:^|\/)\.?justfile$/i, /\.just$/i];

const LOCKFILE_BASENAMES = new Set([
  "Cargo.lock", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
  "uv.lock", "poetry.lock", "pubspec.lock", "go.sum", "flake.lock", "rust-toolchain",
  "rust-toolchain.toml", ".python-version", ".node-version", ".nvmrc", ".tool-versions",
  "renovate.json",
]);

const CONFIG_BASENAMES = new Set([
  ...LOCKFILE_BASENAMES, "Cargo.toml", "package.json", "pyproject.toml", "pubspec.yaml",
  "go.mod", "tsconfig.json", "tsconfig.base.json", "biome.json", "biome.jsonc",
]);

const ARTIFACT_PART_NAMES = new Set(["build", "package", "package-tools", "dist", "release"]);

export const sha256Hex = (input) => createHash("sha256").update(input).digest("hex");
export const isSha = (value) => typeof value === "string" && SHA_PATTERN.test(value);

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function normalizeCacheEpoch(raw) {
  const value = String(raw ?? "").trim() || DEFAULT_CACHE_EPOCH;
  if (!EPOCH_PATTERN.test(value)) {
    throw new Error("cache-epoch must be 1 to 64 safe characters (A-Z, a-z, 0-9, ., _, -).");
  }
  return value;
}

export function normalizeCanaryPercent(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return DEFAULT_CANARY_PERCENT;
  if (!/^\d{1,3}$/.test(text) || Number(text) > 100) {
    throw new Error("canary-percent must be an integer between 0 and 100.");
  }
  return Number(text);
}

export function normalizeGatewayUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return "";
    }
    return parsed.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function writeReceiptMetadata(runnerTemp, { mode = "", reusedRunId = "", bypassReason = "", canaryResult = "" } = {}) {
  if (!runnerTemp) return;
  const payload = {};
  if (mode) payload.mode = String(mode);
  if (reusedRunId) payload.reused_run_id = String(reusedRunId);
  if (bypassReason) payload.bypass_reason = String(bypassReason);
  if (canaryResult) payload.canary_result = String(canaryResult);
  try {
    mkdirSync(runnerTemp, { recursive: true });
    writeFileSync(path.join(runnerTemp, "nddev-ci-receipt.json"), JSON.stringify(payload));
  } catch {
    // Telemetry metadata is best-effort.
  }
}

export function writeActionOutputs(file, pairs) {
  if (!file) return;
  let chunk = "";
  for (const [name, raw] of Object.entries(pairs)) {
    const value = String(raw ?? "");
    if (value.includes("\n") || value.includes("\r")) {
      throw new Error(`Multiline output is not allowed for ${name}.`);
    }
    chunk += `${name}=${value}\n`;
  }
  if (chunk) appendFileSync(file, chunk);
}

export function parseJsonSafe(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export function readJustDump(cwd, justfile = "") {
  const args = justfile
    ? ["--justfile", justfile, "--working-directory", cwd, "--dump", "--dump-format", "json"]
    : ["--dump", "--dump-format", "json"];
  const result = spawnSync("just", args, { cwd, encoding: "utf8", maxBuffer: 64 << 20, timeout: 15000 });
  return !result.error && result.status === 0 ? parseJsonSafe(result.stdout, null) : null;
}

export function workflowRunUrl(environment = process.env) {
  const server = (environment.GITHUB_SERVER_URL || "https://github.com").replace(/\/$/, "");
  return `${server}/${environment.GITHUB_REPOSITORY || ""}/actions/runs/${environment.GITHUB_RUN_ID || ""}`;
}

export function readEventContext(environment = process.env) {
  const payload = environment.GITHUB_EVENT_PATH && existsSync(environment.GITHUB_EVENT_PATH)
    ? parseJsonSafe(readFileSync(environment.GITHUB_EVENT_PATH, "utf8"), {})
    : {};
  const eventName = environment.EVENT || environment.GITHUB_EVENT_NAME || "";
  const privateRepo = environment.PRIVATE_REPO !== undefined
    ? environment.PRIVATE_REPO === "true"
    : typeof payload?.repository?.private === "boolean"
      ? payload.repository.private
      : environment.RUNNER_ENVIRONMENT === "self-hosted";
  const repositoryId = environment.GITHUB_REPOSITORY_ID ||
    (payload?.repository?.id !== undefined ? String(payload.repository.id) : "");
  const baseSha = environment.BASE_SHA ||
    (eventName === "pull_request"
      ? payload?.pull_request?.base?.sha
      : eventName === "merge_group"
        ? payload?.merge_group?.base_sha
        : payload?.before) || "";
  const headSha = environment.HEAD_SHA ||
    (eventName === "pull_request"
      ? payload?.pull_request?.head?.sha
      : eventName === "merge_group"
        ? payload?.merge_group?.head_sha
        : environment.GITHUB_SHA) ||
    environment.GITHUB_SHA || "";
  return { eventName, privateRepo, repositoryId, baseSha, headSha };
}

export function classifyPathBypass(filePath) {
  const normalized = String(filePath ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized) return "";
  if (WORKFLOW_PATH_PATTERNS.some((p) => p.test(normalized))) return "workflow-edit";
  if (JUSTFILE_PATH_PATTERNS.some((p) => p.test(normalized))) return "justfile-edit";
  const base = path.posix.basename(normalized);
  if (LOCKFILE_BASENAMES.has(base) || base.endsWith(".lock.toml") || base.endsWith(".lock.json")) {
    return "lockfile-edit";
  }
  return "";
}

export function isLockOrConfigPath(filePath) {
  const normalized = String(filePath ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  return Boolean(normalized) && (Boolean(classifyPathBypass(normalized)) || CONFIG_BASENAMES.has(path.posix.basename(normalized)));
}

export function isReleaseRef(ref) {
  const value = String(ref ?? "");
  return value === "refs/heads/main" || value.startsWith("refs/tags/") || value.startsWith("refs/heads/release/");
}

export function evaluateBypass({
  reuse = true, ref = "", reports = "", dirty = false, workflowSha = "",
  treeSha = "", changedFiles = null, artifact = "", wholeJobArtifact = false,
} = {}) {
  if (reuse === false || String(reuse).toLowerCase() === "false") return { bypass: true, reason: "disabled" };
  if (isReleaseRef(ref)) return { bypass: true, reason: "release-ref" };
  if (String(reports ?? "").trim() !== "") return { bypass: true, reason: "reports-required" };
  if (wholeJobArtifact && String(artifact ?? "").trim() !== "") return { bypass: true, reason: "artifact-output" };
  if (dirty) return { bypass: true, reason: "dirty-worktree" };
  if (!isSha(workflowSha) || !isSha(treeSha)) return { bypass: true, reason: "missing-identity" };
  if (changedFiles === null) return { bypass: true, reason: "diff-unavailable" };
  for (const file of changedFiles) {
    const reason = classifyPathBypass(file);
    if (reason) return { bypass: true, reason };
  }
  return { bypass: false, reason: "" };
}

export function isArtifactProducingPart(part) {
  const argv = Array.isArray(part?.argv) ? part.argv : [];
  const names = [String(part?.group ?? "").toLowerCase(), ...argv.map((item) => String(item).toLowerCase())];
  return names.some((name) =>
    ARTIFACT_PART_NAMES.has(name) || name.startsWith("build-") || name.startsWith("release-") ||
    name.startsWith("package-") || name.endsWith("::build") || name.endsWith("::release")
  );
}

export function selectCanary({ repository, runId, sha, percent = DEFAULT_CANARY_PERCENT, eventName = "push", ref = "" }) {
  const rate = normalizeCanaryPercent(percent);
  if (eventName !== "push" || ref !== "refs/heads/dev" || rate === 0) {
    return { canary: false, bucket: null, percent: rate };
  }
  const bucket = createHash("sha256").update(`${repository}:${runId}:${sha}:canary`).digest().readUInt32BE(0) % 100;
  return { canary: bucket < rate, bucket, percent: rate };
}

export function gitTreeState(cwd) {
  const tree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8", timeout: 15000 });
  const treeSha = tree.status === 0 ? tree.stdout.trim() : "";
  if (!isSha(treeSha)) return { treeSha: "", dirty: true, lockfilesDigest: "" };
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd, encoding: "utf8", timeout: 15000 });
  const dirty = status.status !== 0 || status.stdout.trim() !== "";
  const listed = spawnSync("git", ["ls-files", "-s", "-z"], { cwd, encoding: "utf8", maxBuffer: 64 << 20, timeout: 15000 });
  const lockEntries = [];
  if (listed.status === 0) {
    for (const entry of listed.stdout.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab === -1) continue;
      const filePath = entry.slice(tab + 1);
      if (isLockOrConfigPath(filePath)) {
        const meta = entry.slice(0, tab).split(" ");
        lockEntries.push(`${meta[0]}\t${meta[1]}\t${filePath}`);
      }
    }
  }
  lockEntries.sort();
  return { treeSha, dirty, lockfilesDigest: sha256Hex(lockEntries.join("\n")) };
}

export function localGitChangedFiles(cwd, baseSha, headSha) {
  if (!isSha(baseSha) || !isSha(headSha) || /^0+$/.test(baseSha)) return null;
  const diff = spawnSync("git", ["diff", "--name-only", `${baseSha}..${headSha}`], { cwd, encoding: "utf8", timeout: 15000, maxBuffer: 16 << 20 });
  return diff.status === 0 ? diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : null;
}

export async function fetchChangedFiles({
  cwd, apiUrl = "https://api.github.com", repository = "", baseSha = "", headSha = "", token = "", fetchImpl = fetch,
} = {}) {
  if (!isSha(baseSha) || !isSha(headSha) || /^0+$/.test(baseSha)) return null;
  if (baseSha === headSha) return [];
  const local = cwd ? localGitChangedFiles(cwd, baseSha, headSha) : null;
  if (local !== null) return local;
  if (!REPO_PATTERN.test(repository) || !token) return null;
  try {
    const response = await fetchImpl(`${apiUrl.replace(/\/$/, "")}/repos/${repository}/compare/${baseSha}...${headSha}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!Array.isArray(payload.files) || payload.status === "diverged" || payload.files.length >= 300) return null;
    return payload.files.flatMap((e) => [e?.filename, e?.previous_filename]).filter((n) => typeof n === "string" && n.length > 0);
  } catch {
    return null;
  }
}

function resolveJustRecipe(dump, scope, name) {
  const parts = [...scope, ...String(name).split("::")];
  let mod = dump;
  for (const step of parts.slice(0, -1)) {
    mod = mod?.modules?.[step];
    if (!mod) return null;
  }
  const recipe = mod?.recipes?.[parts.at(-1)];
  if (recipe) return { key: parts.join("::"), scope: parts.slice(0, -1), recipe };
  const alias = mod?.aliases?.[parts.at(-1)];
  return alias?.target ? resolveJustRecipe(dump, parts.slice(0, -1), alias.target) : null;
}

function collectRecipeClosure(dump, startNames) {
  const collected = {};
  const stack = startNames.map((name) => resolveJustRecipe(dump, [], name)).filter(Boolean);
  while (stack.length > 0) {
    const current = stack.pop();
    if (Object.hasOwn(collected, current.key)) continue;
    collected[current.key] = current.recipe;
    for (const dep of current.recipe.dependencies ?? []) {
      const next = resolveJustRecipe(dump, current.scope, dep.recipe);
      if (next && !Object.hasOwn(collected, next.key)) stack.push(next);
    }
  }
  return collected;
}

export function recipeClosureDigest(dump, argv, { workingDirectory = ".", justfile = "justfile", setup = false } = {}) {
  const normalizedArgv = Array.isArray(argv) ? argv.map(String) : [];
  const roots = normalizedArgv.length > 0 ? [normalizedArgv[0]] : [];
  if (setup && dump?.recipes?.setup) roots.push("setup");
  return sha256Hex(canonicalJson({
    argv: normalizedArgv,
    workingDirectory: String(workingDirectory || "."),
    justfile: String(justfile || "justfile"),
    setup: Boolean(setup),
    settings: dump?.settings ?? null,
    assignments: dump?.assignments ?? null,
    aliases: dump?.aliases ?? null,
    recipes: dump ? collectRecipeClosure(dump, roots) : {},
  }));
}

export function inspectVerifyDecomposition(dump) {
  const verify = dump?.recipes?.verify;
  if (!verify) return { canDecompose: false, priors: [], hasBody: false };
  const deps = verify.dependencies ?? [];
  if ((verify.parameters ?? []).length > 0 || verify.priors !== deps.length) {
    return { canDecompose: false, priors: [], hasBody: false };
  }
  if (deps.length === 0) return { canDecompose: false, priors: [], hasBody: (verify.body ?? []).length > 0 };
  const priors = [];
  const seen = new Set();
  for (const dep of deps) {
    const target = resolveJustRecipe(dump, [], dep.recipe);
    if (!target || seen.has(target.key)) return { canDecompose: false, priors: [], hasBody: false };
    const args = dep.arguments ?? [];
    if (args.some((a) => typeof a !== "string" || a.startsWith("-")) ||
        (target.recipe.parameters ?? []).some((p) => p.kind !== "singular")) {
      return { canDecompose: false, priors: [], hasBody: false };
    }
    seen.add(target.key);
    const closure = collectRecipeClosure(dump, [target.key]);
    delete closure[target.key];
    priors.push({ key: target.key, argv: [target.key, ...args], needs: Object.keys(closure) });
  }
  return { canDecompose: true, priors, hasBody: (verify.body ?? []).length > 0 };
}

function probeCommandVersion(command, args, env) {
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 5000, maxBuffer: 1 << 20 });
  return !result.error && result.status === 0 ? (result.stdout || result.stderr || "").trim() : "";
}

export function computeToolchainAndRunnerDigests(environment = process.env, declared = {}, { probedOverride = null } = {}) {
  const managed = environment.RUNNER_ENVIRONMENT === "self-hosted";
  const pick = (camel, kebab) => String(declared[camel] ?? declared[kebab] ?? "");
  const declaredInputs = {
    node: pick("nodeVersion", "node-version"), python: pick("pythonVersion", "python-version"),
    uv: pick("uvVersion", "uv-version"), bun: pick("bunVersion", "bun-version"),
    rust: pick("rustVersion", "rust-version"), rustComponents: pick("rustComponents", "rust-components"),
    rustTargets: pick("rustTargets", "rust-targets"), java: pick("javaVersion", "java-version"),
    go: pick("goVersion", "go-version"), dart: pick("dartVersion", "dart-version"),
    flutter: pick("flutterVersion", "flutter-version"), tools: pick("tools", "tools"),
    toolAssets: pick("toolAssets", "tool-assets"), setup: Boolean(declared.setup), images: Boolean(declared.images),
    prepare: pick("prepare", "prepare"), submodules: pick("submodules", "submodules"),
    sparseCheckout: pick("sparseCheckout", "sparse-checkout"), sparseCheckoutConeMode: pick("sparseCheckoutConeMode", "sparse-checkout-cone-mode"),
  };
  const runnerInfo = {
    environment: environment.RUNNER_ENVIRONMENT ?? "",
    os: environment.RUNNER_OS ?? "",
    arch: environment.RUNNER_ARCH ?? "",
    profile: managed
      ? (environment.NDDEV_CI_RUNNER_PROFILE || pick("runnerProfile", "runner-profile"))
      : pick("runnerProfile", "runner-profile"),
    sdkLockSha256: managed ? (environment.NDDEV_CI_SDK_LOCK_SHA256 ?? "") : "",
    imageOs: managed ? "" : (environment.ImageOS ?? ""),
    imageVersion: managed ? "" : (environment.ImageVersion ?? ""),
    registryCommit: pick("registryCommit", "registry-commit"),
  };
  if (managed && !runnerInfo.sdkLockSha256 && process.platform === "linux" && existsSync("/etc/os-release")) {
    runnerInfo.osRelease = sha256Hex(readFileSync("/etc/os-release", "utf8"));
  } else if (!managed && !runnerInfo.imageVersion) {
    runnerInfo.osRelease = os.release();
  }
  const probed = probedOverride
    ? { just: String(probedOverride.just ?? "") }
    : { just: probeCommandVersion("just", ["--version"], environment) };
  if (managed && !runnerInfo.sdkLockSha256 && !probedOverride) {
    for (const [name, cmd, args] of [
      ["rustc", "rustc", ["-vV"]], ["node", "node", ["--version"]], ["bun", "bun", ["--version"]],
      ["python3", "python3", ["--version"]], ["uv", "uv", ["--version"]], ["go", "go", ["version"]],
    ]) {
      const value = probeCommandVersion(cmd, args, environment);
      if (value) probed[name] = value;
    }
  }
  return {
    runnerDigest: sha256Hex(canonicalJson(runnerInfo)),
    toolchainDigest: sha256Hex(canonicalJson({ declared: declaredInputs, probed })),
    runnerInfo,
  };
}

export function resolveWorkflowSha(environment = process.env, oidcClaims = null) {
  const oidcSha = oidcClaims?.job_workflow_sha ?? "";
  const actionRef = environment.NDDEV_CI_ACTION_REF || environment.GITHUB_ACTION_REF || "";
  if (isSha(oidcSha)) {
    if (isSha(actionRef) && actionRef !== oidcSha) {
      throw new Error("Workflow SHA mismatch between OIDC token and action reference.");
    }
    return oidcSha;
  }
  if (isSha(actionRef)) return actionRef;
  const actionRepo = environment.NDDEV_CI_ACTION_REPO || environment.GITHUB_ACTION_REPOSITORY || "";
  const currentRepo = environment.GITHUB_REPOSITORY ?? "";
  return (!actionRepo || actionRepo === currentRepo) && isSha(environment.GITHUB_SHA) ? environment.GITHUB_SHA : "";
}

export function checkIdForArgv(argv, { kind = "check", workingDirectory = ".", justfile = "justfile" } = {}) {
  const base = Array.isArray(argv) && argv.length > 0 ? argv.map(String).join(" ") : "verify";
  const prefix = kind === "recipe" ? "recipe:" : "just:";
  const suffix = (workingDirectory && workingDirectory !== ".") || (justfile && justfile !== "justfile")
    ? `@${workingDirectory}:${justfile}`
    : "";
  return `${prefix}${base}${suffix}`;
}

export function computeInputDigest({
  cacheEpoch = DEFAULT_CACHE_EPOCH, workflowSha, checkId, treeSha,
  lockfilesDigest, recipeDigest, toolchainDigest, runnerDigest, envDigest = "",
}) {
  return sha256Hex(canonicalJson({
    schema: RECEIPT_SCHEMA, cache_epoch: normalizeCacheEpoch(cacheEpoch),
    workflow_sha: workflowSha, check_id: checkId, tree_sha: treeSha,
    lockfiles_digest: lockfilesDigest, recipe_digest: recipeDigest,
    toolchain_digest: toolchainDigest, runner_digest: runnerDigest, env_digest: envDigest,
  }));
}

export function targetRunnerForPart({
  privateRepo, runner = "nddev-linux-standart", runnerProfile = "",
  hostedRunner = "ubuntu-24.04", partRunners = {}, partGroup = "",
} = {}) {
  if (!privateRepo) {
    const label = hostedRunner || "ubuntu-24.04";
    const osName = label.startsWith("macos") ? "macOS" : label.startsWith("windows") ? "Windows" : "Linux";
    const arch = label.endsWith("-arm") || label.startsWith("macos") ? "ARM64" : "X64";
    return { environment: "github-hosted", os: osName, arch, profile: runnerProfile, archIndependent: false };
  }
  const effective = (partGroup && partRunners && partRunners[partGroup]) || runner;
  if (effective === "nddev-linux-light") return { environment: "self-hosted", os: "Linux", arch: "", profile: "", archIndependent: true };
  if (effective === "nddev-linux-arm64") return { environment: "self-hosted", os: "Linux", arch: "ARM64", profile: "linux-arm64", archIndependent: false };
  if (effective === "nddev-macos" || runnerProfile === "macos-arm64") return { environment: "self-hosted", os: "macOS", arch: "ARM64", profile: "macos-arm64", archIndependent: false };
  if (effective === "nddev-windows" || runnerProfile === "windows-x64") return { environment: "self-hosted", os: "Windows", arch: "X64", profile: "windows-x64", archIndependent: false };
  if (effective === "nddev-linux-standart" || effective === "nddev-linux-small" || runnerProfile === "linux-x64") {
    return { environment: "self-hosted", os: "Linux", arch: "X64", profile: "linux-x64", archIndependent: false };
  }
  return { environment: "self-hosted", os: "", arch: "", profile: runnerProfile, archIndependent: false };
}

export function planMatchesTarget(environment, target) {
  if (!target?.environment || (environment.RUNNER_ENVIRONMENT ?? "") !== target.environment) return false;
  if (target.os && (environment.RUNNER_OS ?? "") !== target.os) return false;
  if (target.archIndependent) return true;
  if (target.arch && (environment.RUNNER_ARCH ?? "") !== target.arch) return false;
  if (target.environment === "self-hosted" && target.profile) {
    const current = environment.NDDEV_CI_RUNNER_PROFILE ?? "";
    if (current && current !== target.profile) return false;
  }
  return true;
}

export function dssePae(payloadType, payloadBytes) {
  const typeBytes = Buffer.from(payloadType, "utf8");
  const body = Buffer.isBuffer(payloadBytes) ? payloadBytes : Buffer.from(payloadBytes, "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${typeBytes.length} `, "utf8"), typeBytes, Buffer.from(` ${body.length} `, "utf8"), body]);
}

export function signDsseEnvelope(statement, privateKeyPem, keyId = "gateway") {
  const payloadBytes = Buffer.from(canonicalJson(statement), "utf8");
  const signature = cryptoSign(null, dssePae(DSSE_PAYLOAD_TYPE, payloadBytes), privateKeyPem);
  return { payloadType: DSSE_PAYLOAD_TYPE, payload: payloadBytes.toString("base64"), signatures: [{ keyid: keyId, sig: signature.toString("base64") }] };
}

export function verifyReceiptStatement(statement, expected, nowMs = Date.now()) {
  if (!statement || typeof statement !== "object") return { valid: false, reason: "malformed-statement" };
  if (statement.schema !== RECEIPT_SCHEMA) return { valid: false, reason: "schema-mismatch" };
  if (statement.status !== "success") return { valid: false, reason: "not-success" };
  if (statement.repository !== expected.repository) return { valid: false, reason: "repository-mismatch" };
  if (expected.repositoryId && String(statement.repository_id ?? "") !== String(expected.repositoryId)) {
    return { valid: false, reason: "repository-id-mismatch" };
  }
  if (statement.tree_sha !== expected.treeSha) return { valid: false, reason: "tree-mismatch" };
  if (statement.input_digest !== expected.inputDigest) return { valid: false, reason: "digest-mismatch" };
  if (statement.job_workflow_sha !== expected.workflowSha) return { valid: false, reason: "workflow-sha-mismatch" };
  if (statement.cache_epoch !== expected.cacheEpoch) return { valid: false, reason: "epoch-mismatch" };
  if (statement.check_id !== expected.checkId) return { valid: false, reason: "check-id-mismatch" };
  if (Array.isArray(expected.allowedNamespaces) && !expected.allowedNamespaces.includes(statement.namespace)) {
    return { valid: false, reason: "namespace-disallowed" };
  }
  const issuedMs = Date.parse(statement.issued_at ?? "");
  const expiresMs = Date.parse(statement.expires_at ?? "");
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) return { valid: false, reason: "invalid-timestamps" };
  if (nowMs >= expiresMs || issuedMs > nowMs + 5 * 60 * 1000) return { valid: false, reason: "expired" };
  const maxAge = statement.namespace === "pr" ? PR_MAX_AGE_MS : TRUSTED_MAX_AGE_MS;
  return nowMs - issuedMs > maxAge ? { valid: false, reason: "stale" } : { valid: true, receipt: statement };
}

export function verifySignedReceipt(envelope, publicKeyPem, expected, nowMs = Date.now()) {
  if (!envelope || typeof envelope !== "object" || envelope.payloadType !== DSSE_PAYLOAD_TYPE) {
    return { valid: false, reason: "payload-type-mismatch" };
  }
  if (typeof envelope.payload !== "string" || !Array.isArray(envelope.signatures) || envelope.signatures.length === 0) {
    return { valid: false, reason: "missing-signature" };
  }
  if (!publicKeyPem || typeof publicKeyPem !== "string") return { valid: false, reason: "missing-public-key" };
  const payloadBytes = Buffer.from(envelope.payload, "base64");
  const pae = dssePae(envelope.payloadType, payloadBytes);
  let verified = false;
  for (const entry of envelope.signatures) {
    if (typeof entry?.sig !== "string") continue;
    try {
      const sigBytes = Buffer.from(entry.sig, "base64");
      if (sigBytes.length === 64 && cryptoVerify(null, pae, publicKeyPem, sigBytes)) { verified = true; break; }
    } catch { continue; }
  }
  if (!verified) return { valid: false, reason: "invalid-signature" };
  const statement = parseJsonSafe(payloadBytes.toString("utf8"), null);
  return statement ? verifyReceiptStatement(statement, expected, nowMs) : { valid: false, reason: "invalid-statement-json" };
}

export function decodeJwtPayload(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  return parseJsonSafe(Buffer.from(parts[1].replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8"), null);
}

export async function fetchOidcToken(environment = process.env, audience = DEFAULT_OIDC_AUDIENCE, fetchImpl = fetch) {
  const requestUrl = environment.ACTIONS_ID_TOKEN_REQUEST_URL ?? "";
  const requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "";
  if (!requestUrl || !requestToken) return null;
  const url = `${requestUrl}${requestUrl.includes("?") ? "&" : "?"}audience=${encodeURIComponent(audience)}`;
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json; api-version=2.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data?.value === "string" && data.value ? { token: data.value, claims: decodeJwtPayload(data.value) } : null;
  } catch {
    return null;
  }
}

export function sanitizeProjectEnv(environment = process.env) {
  const blocked = new Set([
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "NDDEV_CI_RECEIPT_TOKEN",
    "INPUT_GITHUB-TOKEN",
    "RECEIPT_PLAN",
    "RECEIPT_RESULTS",
  ]);
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !blocked.has(key)));
}

export async function fetchGatewayRunnerInfo({ gatewayUrl, profile, fetchImpl = fetch }) {
  const base = normalizeGatewayUrl(gatewayUrl);
  if (!base || !profile || !/^[a-z0-9-]+$/.test(profile)) return null;
  try {
    const query = new URLSearchParams({ profile });
    const response = await fetchImpl(`${base}/.nddev/receipts/v1/runner-info?${query}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (
      body?.environment !== "self-hosted" ||
      body?.profile !== profile ||
      typeof body?.os !== "string" || !body.os ||
      typeof body?.arch !== "string" || !body.arch ||
      typeof body?.sdk_lock_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.sdk_lock_sha256)
    ) return null;
    return {
      environment: "self-hosted",
      os: body.os,
      arch: body.arch,
      profile: body.profile,
      sdkLockSha256: body.sdk_lock_sha256,
      justVersion: typeof body.just_version === "string" ? body.just_version : "",
    };
  } catch {
    return null;
  }
}

export async function lookupGatewayReceipt({
  gatewayUrl, repositoryId, inputDigest, scopes = ["trusted", "pr"], expected, nowMs = Date.now(), fetchImpl = fetch,
}) {
  const base = normalizeGatewayUrl(gatewayUrl);
  if (!base || !DIGEST_HEX_PATTERN.test(inputDigest)) return { hit: false, reason: "unavailable" };
  const query = new URLSearchParams({ repository_id: String(repositoryId ?? ""), input_digest: inputDigest, scopes: scopes.join(",") });
  try {
    const response = await fetchImpl(`${base}/.nddev/receipts/v1/lookup?${query}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) return { hit: false, reason: "miss" };
    if (!response.ok) return { hit: false, reason: `gateway-http-${response.status}` };
    const body = await response.json();
    let publicKeyPem = body?.public_key_pem ?? "";
    if (!publicKeyPem) {
      const keyRes = await fetchImpl(`${base}/.nddev/receipts/v1/public-key`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000),
      });
      if (keyRes.ok) publicKeyPem = (await keyRes.json())?.public_key_pem ?? "";
    }
    const verified = verifySignedReceipt(body?.envelope, publicKeyPem, expected, nowMs);
    return verified.valid ? { hit: true, receipt: verified.receipt } : { hit: false, reason: verified.reason };
  } catch {
    return { hit: false, reason: "gateway-error" };
  }
}

export async function issueGatewayReceipt({ gatewayUrl, oidcToken, payload, fetchImpl = fetch }) {
  const base = normalizeGatewayUrl(gatewayUrl);
  if (!base || !oidcToken) return { issued: false, reason: "unavailable" };
  try {
    const response = await fetchImpl(`${base}/.nddev/receipts/v1/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${oidcToken}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { issued: false, reason: `gateway-http-${response.status}` };
    const body = await response.json();
    return { issued: true, namespace: body?.namespace ?? "", key: body?.key ?? "" };
  } catch {
    return { issued: false, reason: "gateway-error" };
  }
}

// OIDC binds a receipt to a GitHub job, but it does not attest a successful CI run.
export function createSourceProof(environment, { workflowSha, treeSha, baseSha, repository, repositoryId, token }, fetchImpl = fetch) {
  const workflowRef = environment.GITHUB_WORKFLOW_REF || "";
  const workflowPath = workflowRef.slice(repository.length + 1).split("@", 1)[0];
  const api = (environment.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const requests = new Map();

  function read(resource) {
    if (!requests.has(resource)) {
      requests.set(resource, Promise.resolve().then(async () => {
        const response = await fetchImpl(`${api}/repos/${repository}/${resource}`, {
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        return response.ok ? await response.json() : null;
      }).catch(() => null));
    }
    return requests.get(resource);
  }

  return async (receipt, workflow) => {
    if (!token || !REPO_PATTERN.test(repository) || !workflowRef.startsWith(`${repository}/.github/workflows/`) ||
        !["check", "recipe"].includes(workflow) || receipt.event_name !== "pull_request" ||
        !/^refs\/pull\/[1-9]\d*\/merge$/.test(receipt.ref) || !/^\d+$/.test(receipt.run_id) ||
        !Number.isSafeInteger(receipt.run_attempt) || receipt.run_attempt < 1 || !isSha(receipt.sha)) return false;

    const run = await read(`actions/runs/${receipt.run_id}`);
    const reusablePath = `NDDev-Technocracy-OpenNetwork/nddev-ci/.github/workflows/${workflow}.yml@${workflowSha}`;
    if (String(run?.id) !== receipt.run_id || String(run?.repository?.id) !== repositoryId ||
        run.event !== "pull_request" || run.path !== workflowPath || run.run_attempt !== receipt.run_attempt ||
        run.status !== "completed" || run.conclusion !== "success" ||
        !Array.isArray(run.referenced_workflows) ||
        !run.referenced_workflows.some((item) => item?.path === reusablePath && item.sha === workflowSha)) return false;

    // GitHub reports the PR head on the run and the tested merge commit in OIDC.
    const commit = await read(`git/commits/${receipt.sha}`);
    return commit?.sha === receipt.sha && commit?.tree?.sha === treeSha &&
      Array.isArray(commit.parents) && commit.parents.length === 2 &&
      isSha(baseSha) && commit.parents[0]?.sha === baseSha &&
      isSha(run.head_sha) && commit.parents[1]?.sha === run.head_sha;
  };
}

export async function buildReceiptSession(environment = process.env, workflowInputs = {}, { wholeJobArtifact = false, deps = {} } = {}) {
  const cwd = environment.GITHUB_WORKSPACE || process.cwd();
  const ev = readEventContext(environment);
  const reuseEnabled = workflowInputs["reuse-receipts"] !== false && String(workflowInputs["reuse-receipts"] ?? "true") !== "false";
  const cacheEpoch = normalizeCacheEpoch(workflowInputs["cache-epoch"] || environment.NDDEV_CI_CACHE_EPOCH || environment.CACHE_EPOCH);
  const canaryPercent = normalizeCanaryPercent(workflowInputs["canary-percent"] ?? "5");
  const artifact = String(workflowInputs.artifact ?? "").trim();
  const reports = String(workflowInputs.reports ?? "").trim();
  const ref = environment.GITHUB_REF || "";
  const repository = environment.GITHUB_REPOSITORY || "";
  const runId = environment.GITHUB_RUN_ID || "";
  const runAttempt = Number(environment.GITHUB_RUN_ATTEMPT || 1);
  const token = environment.GH_TOKEN || environment.GITHUB_TOKEN || environment["INPUT_GITHUB-TOKEN"] || "";
  const gatewayUrl = ev.privateRepo && environment.RUNNER_ENVIRONMENT === "self-hosted"
    ? normalizeGatewayUrl(environment.NDDEV_CI_RECEIPT_GATEWAY || "")
    : "";
  const treeState = (deps.gitTreeState ?? gitTreeState)(cwd);
  const workflowSha = (deps.resolveWorkflowSha ?? resolveWorkflowSha)(environment, null);
  const hasPartPaths = Boolean(workflowInputs["part-paths"] && String(workflowInputs["part-paths"]).trim() !== "" && String(workflowInputs["part-paths"]).trim() !== "{}");
  const changedFiles = (reuseEnabled || hasPartPaths)
    ? await (deps.fetchChangedFiles ?? fetchChangedFiles)({
      cwd, apiUrl: environment.GITHUB_API_URL || "https://api.github.com",
      repository, baseSha: ev.baseSha, headSha: ev.headSha, token, fetchImpl: deps.fetchImpl,
    })
    : [];
  const bypass = evaluateBypass({
    reuse: reuseEnabled, ref, reports, dirty: treeState.dirty, workflowSha,
    treeSha: treeState.treeSha, changedFiles, artifact, wholeJobArtifact,
  });
  const canaryState = bypass.bypass
    ? { canary: false, bucket: null, percent: canaryPercent }
    : selectCanary({ repository, runId, sha: ev.headSha, percent: canaryPercent, eventName: ev.eventName, ref });
  const { runnerDigest, toolchainDigest } = (deps.computeToolchainAndRunnerDigests ?? computeToolchainAndRunnerDigests)(
    environment, workflowInputs,
  );
  return {
    cwd, privateRepo: ev.privateRepo, eventName: ev.eventName, ref, repository,
    repositoryId: ev.repositoryId, runId, runAttempt, runUrl: workflowRunUrl(environment),
    sha: ev.headSha, treeSha: treeState.treeSha, dirty: treeState.dirty,
    lockfilesDigest: treeState.lockfilesDigest, workflowSha, runnerDigest, toolchainDigest,
    cacheEpoch, artifact, reports, bypass, canary: canaryState.canary, gatewayUrl, changedFiles,
    verifySource: (deps.createSourceProof ?? createSourceProof)(environment, {
      workflowSha, treeSha: treeState.treeSha, baseSha: ev.baseSha, repository, repositoryId: ev.repositoryId, token,
    }, deps.fetchImpl),
  };
}

export async function lookupStepInSession(session, { checkId, inputDigest }, deps = {}) {
  if (session.bypass.bypass || session.eventName !== "push" || session.ref !== "refs/heads/dev" ||
      !inputDigest || !session.privateRepo || !session.gatewayUrl) {
    return { hit: false, reason: "skipped" };
  }
  const lookup = await (deps.lookupGatewayReceipt ?? lookupGatewayReceipt)({
    gatewayUrl: session.gatewayUrl,
    repositoryId: session.repositoryId,
    inputDigest,
    scopes: ["pr"],
    expected: {
      repository: session.repository, repositoryId: session.repositoryId,
      treeSha: session.treeSha, inputDigest, workflowSha: session.workflowSha,
      cacheEpoch: session.cacheEpoch, checkId, allowedNamespaces: ["pr"],
    },
    fetchImpl: deps.fetchImpl,
  });
  if (!lookup.hit) return lookup;
  const workflow = checkId.startsWith("recipe:") ? "recipe" : "check";
  return await session.verifySource(lookup.receipt, workflow) ? lookup : { hit: false, reason: "unverified-source-run" };
}

export async function issueStepInSession(session, { checkId, argv, inputDigest }, oidcToken, deps = {}) {
  return (deps.issueGatewayReceipt ?? issueGatewayReceipt)({
    gatewayUrl: session.gatewayUrl,
    oidcToken,
    payload: {
      check_id: checkId, argv, tree_sha: session.treeSha, input_digest: inputDigest,
      runner_digest: session.runnerDigest, toolchain_digest: session.toolchainDigest,
      cache_epoch: session.cacheEpoch, status: "success",
      run_id: session.runId, run_attempt: session.runAttempt, run_url: session.runUrl,
    },
    fetchImpl: deps.fetchImpl,
  });
}

export function makeSummaryEntry(base, overrides = {}) {
  return {
    label: base.label, checkId: base.checkId, outcome: overrides.outcome ?? "executed",
    reused: Boolean(overrides.reused), canaryResult: overrides.canaryResult ?? "",
    reusedRunId: overrides.reusedRunId ?? base.reusedRunId ?? "",
    reusedRunUrl: overrides.reusedRunUrl ?? base.reusedRunUrl ?? "",
    reusedEvent: overrides.reusedEvent ?? base.reusedEvent ?? "",
    treeSha: overrides.treeSha ?? base.treeSha ?? "",
    inputDigest: overrides.inputDigest ?? base.inputDigest ?? "",
  };
}

export function formatReceiptSummary(entries, { bypassReason = "", canary = false } = {}) {
  const lines = ["### Step receipt reuse", ""];
  if (bypassReason) lines.push(`Reuse bypassed: \`${bypassReason}\` (all steps executed fresh).`, "");
  else if (canary) lines.push("Canary verification run: cached steps re-executed fresh and compared against stored receipts.", "");
  if (!Array.isArray(entries) || entries.length === 0) return lines.join("\n");
  lines.push("| Step | Outcome | Reused run | Source event | Tree | Input digest |", "| --- | --- | --- | --- | --- | --- |");
  for (const entry of entries) {
    const label = `\`${String(entry.label || entry.checkId || "step").replaceAll("`", "")}\``;
    const runCell = entry.reusedRunId
      ? (entry.reusedRunUrl ? `[#${entry.reusedRunId}](${entry.reusedRunUrl})` : `#${entry.reusedRunId}`)
      : "—";
    lines.push(`| ${label} | ${entry.outcome ?? "executed"} | ${runCell} | ${entry.reusedEvent ? `\`${entry.reusedEvent}\`` : "—"} | ${entry.treeSha ? `\`${entry.treeSha.slice(0, 12)}\`` : "—"} | ${entry.inputDigest ? `\`sha256:${entry.inputDigest.slice(0, 12)}\`` : "—"} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function summarizeReceiptEntries(entries, { bypassReason = "", canary = false } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const reused = list.filter((e) => e.reused === true);
  const mismatched = list.filter((e) => e.canaryResult === "mismatch");
  const matched = list.filter((e) => e.canaryResult === "match");
  let mode = "executed";
  let canaryResult = "";
  if (bypassReason) mode = "bypassed";
  else if (canary && (mismatched.length > 0 || matched.length > 0)) {
    mode = "canary";
    canaryResult = mismatched.length > 0 ? "mismatch" : "match";
  } else if (reused.length > 0) mode = "reused";
  const source = reused[0] ?? mismatched[0] ?? matched[0] ?? null;
  return {
    mode,
    reusedRunId: source?.reusedRunId ? String(source.reusedRunId) : "",
    reusedRunUrl: source?.reusedRunUrl ? String(source.reusedRunUrl) : "",
    reusedCount: reused.length,
    bypassReason: bypassReason || "",
    canaryResult,
  };
}
