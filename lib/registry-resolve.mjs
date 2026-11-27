// Registry snapshot resolution and verification for all four job-needed kinds:
// toolchain, tool, image and action. Pure Node 24 (no Python dependency) so Linux,
// macOS and Windows jobs share one implementation.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ActionError } from "./release-asset.mjs";
import { parseToml } from "./toml.mjs";

const fullCommitPattern = /^[0-9a-f]{40}$/;
const semverCorePattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?$/;

// Canonical mapping from CI SDK input names to technology registry keys.
export const toolchainRegistryKeys = Object.freeze({
  node: ["node"],
  python: ["python"],
  uv: ["uv"],
  bun: ["bun"],
  rust: ["rust"],
  java: ["jdk", "java"],
  jdk: ["jdk", "java"],
  go: ["go"],
  dart: ["dart"],
  flutter: ["flutter+dart", "flutter"],
  dotnet: ["dotnet"],
  ruby: ["ruby"],
  "android-cmdline-tools": ["android-cmdline-tools"],
  "android-platform-tools": ["android-platform-tools"],
  "android-build-tools": ["android-build-tools"],
  "android-platform": ["android-platform"],
  "android-ndk": ["android-ndk"],
  "android-cmake": ["android-cmake"],
  just: ["just"],
  buildx: ["buildx"],
  buildkit: ["buildkit"],
});

const snapshotCache = new Map();

export function loadRegistrySnapshot(environment = process.env) {
  const file = (environment.NDDEV_CI_REGISTRY_SNAPSHOT ?? "").trim();
  if (!file) return null;
  if (!path.isAbsolute(file) || /[\r\n\0]/.test(file)) {
    throw new ActionError("NDDEV_CI_REGISTRY_SNAPSHOT must be an absolute path.");
  }
  let stat;
  try {
    stat = statSync(file);
  } catch {
    throw new ActionError("Protected registry snapshot file could not be read.");
  }
  const cacheKey = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (snapshotCache.has(cacheKey)) return snapshotCache.get(cacheKey);

  let document;
  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ActionError("Protected registry snapshot is malformed JSON.");
  }
  if (document?.schema_version !== 1 || !fullCommitPattern.test(document.registry_commit ?? "") ||
      typeof document.technologies_toml !== "string") {
    throw new ActionError("Protected registry snapshot has an invalid schema or commit.");
  }
  let parsed;
  try {
    parsed = parseToml(document.technologies_toml);
  } catch (error) {
    throw new ActionError(`Protected registry technologies.toml is invalid: ${error.message}`);
  }
  const technologies = parsed?.technologies;
  if (!technologies || typeof technologies !== "object" || Array.isArray(technologies)) {
    throw new ActionError("Protected registry technologies.toml holds no [technologies] table.");
  }
  const loaded = Object.freeze({
    path: file,
    commit: document.registry_commit,
    technologies,
  });
  snapshotCache.set(cacheKey, loaded);
  return loaded;
}

function normalizeLines(name, entry) {
  if (!Array.isArray(entry.lines) || entry.lines.length === 0) {
    throw new ActionError(`Registry technology ${name} declares no accepted lines.`);
  }
  const lines = entry.lines.map((line) => {
    if (!line || typeof line !== "object" || typeof line.version !== "string" || !line.version) {
      throw new ActionError(`Registry technology ${name} contains a malformed line.`);
    }
    return {
      version: line.version,
      role: typeof line.role === "string" ? line.role : "",
      commit: typeof line.commit === "string" ? line.commit : "",
    };
  });
  const latestLines = lines.filter((line) => line.role === "latest");
  const primary = latestLines.length === 1 ? latestLines[0] : (lines.length === 1 ? lines[0] : null);
  return {
    lines,
    latest: primary,
    acceptedVersions: lines.map((line) => line.version),
  };
}

function lookupTechnology(snapshot, keys, allowedKinds, label) {
  if (!snapshot?.technologies) {
    throw new ActionError("A verified registry snapshot is required to resolve " + label + ".");
  }
  for (const key of keys) {
    if (!Object.hasOwn(snapshot.technologies, key)) continue;
    const entry = snapshot.technologies[key];
    if (!entry || typeof entry !== "object") continue;
    if (allowedKinds && !allowedKinds.includes(entry.kind)) {
      throw new ActionError(
        `Registry technology ${key} has kind ${JSON.stringify(entry.kind)}, expected ${allowedKinds.join(" or ")}.`,
      );
    }
    return {
      key,
      kind: entry.kind,
      source: entry.source ?? "",
      digests: entry.digests && typeof entry.digests === "object" && !Array.isArray(entry.digests) ? entry.digests : null,
      ...normalizeLines(key, entry),
    };
  }
  throw new ActionError(`Registry snapshot does not declare ${label}.`);
}

function versionMatchesAccepted(name, requested, acceptedVersions) {
  if (acceptedVersions.includes(requested)) return true;
  if (name === "java" || name === "jdk") {
    const base = requested.split("+")[0];
    return acceptedVersions.some((accepted) => accepted === base || accepted.split("+")[0] === base);
  }
  return false;
}

export function compareVersionsDesc(a, b) {
  const split = (value) => value.split(/[+-]/)[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = split(a);
  const right = split(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

// Kind 1: toolchain
export function resolveToolchain(snapshot, name, requestedVersion = "") {
  const keys = toolchainRegistryKeys[name] ?? [name];
  const entry = lookupTechnology(snapshot, keys, ["toolchain"], `toolchain ${name}`);
  if (requestedVersion) {
    if (!versionMatchesAccepted(name, requestedVersion, entry.acceptedVersions)) {
      throw new ActionError(
        `Toolchain ${name} version ${requestedVersion} is outside the snapshot's accepted lines (${entry.acceptedVersions.join(", ")}).`,
      );
    }
    return { ...entry, version: requestedVersion };
  }
  if (!entry.latest) {
    throw new ActionError(`Toolchain ${name} has no single latest line in the registry snapshot.`);
  }
  return { ...entry, version: entry.latest.version };
}

export function checkToolchain(snapshot, name, measuredVersion) {
  return resolveToolchain(snapshot, name, measuredVersion);
}

// Kind 2: tool
export function resolveTool(snapshot, name, requestedVersion = "") {
  const entry = lookupTechnology(snapshot, [name], ["tool", "toolchain"], `tool ${name}`);
  if (requestedVersion) {
    if (!entry.acceptedVersions.includes(requestedVersion)) {
      throw new ActionError(
        `Tool ${name} version ${requestedVersion} is outside the snapshot's accepted lines (${entry.acceptedVersions.join(", ")}).`,
      );
    }
    return { ...entry, version: requestedVersion };
  }
  if (!entry.latest) {
    throw new ActionError(`Tool ${name} has no single latest line in the registry snapshot.`);
  }
  return { ...entry, version: entry.latest.version };
}

export function checkTool(snapshot, name, measuredVersion) {
  return resolveTool(snapshot, name, measuredVersion);
}

const sha256HexPattern = /^[0-9a-f]{64}$/;
const safeAssetNamePattern = /^[A-Za-z0-9._+-]+$/;
const safeOciAssetPattern = /^[a-z0-9./_-]+:v?[0-9A-Za-z._-]+$/;

export function githubRepositoryFromSource(source) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)(?:\/|$)/.exec(
    String(source ?? "").trim(),
  );
  return match ? match[1] : "";
}

export function resolveToolDigest(snapshot, name, {
  version = "",
  target = `${process.platform}-${process.arch}`,
  optional = false,
} = {}) {
  const entry = resolveTool(snapshot, name, version);
  const byVersion = entry.digests && Object.hasOwn(entry.digests, entry.version)
    ? entry.digests[entry.version]
    : null;
  const spec = byVersion && typeof byVersion === "object" && Object.hasOwn(byVersion, target)
    ? byVersion[target]
    : null;
  if (!spec || typeof spec !== "object") {
    if (optional) return null;
    throw new ActionError(`Registry snapshot declares no ${target} digest for ${name}@${entry.version}.`);
  }
  const asset = typeof spec.asset === "string" ? spec.asset.trim() : "";
  const sha256 = typeof spec.sha256 === "string" ? spec.sha256.trim() : "";
  const assetPattern = target === "oci" ? safeOciAssetPattern : safeAssetNamePattern;
  if (!assetPattern.test(asset) || !sha256HexPattern.test(sha256)) {
    throw new ActionError(`Registry snapshot digest for ${name}@${entry.version} (${target}) is malformed.`);
  }
  return {
    key: entry.key,
    kind: entry.kind,
    source: entry.source,
    repository: githubRepositoryFromSource(entry.source),
    version: entry.version,
    target,
    asset,
    sha256,
  };
}

export function resolveBuildkitImage(snapshot, version = "", { optional = false } = {}) {
  const digest = resolveToolDigest(snapshot, "buildkit", { version, target: "oci", optional });
  if (!digest) return null;
  return `${digest.asset}@sha256:${digest.sha256}`;
}

export function measureToolVersion(binary, toolName, environment = process.env) {
  const probes = ["betterleaks", "poutine"].includes(toolName)
    ? [["version"], ["--version"]]
    : [["--version"]];
  for (const args of probes) {
    const result = spawnSync(binary, args, {
      env: { ...environment, DO_NOT_TRACK: "1", BUN_DO_NOT_TRACK: "1", TRIVY_DISABLE_TELEMETRY: "true" },
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) continue;
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (toolName === "just") {
      const m = text.match(/^just ([0-9]+\.[0-9]+\.[0-9]+)$/m);
      if (m) return m[1];
    }
    if (toolName === "osv-scanner") {
      const m = text.match(/^osv-scanner version:\s*v?([0-9]+\.[0-9]+\.[0-9]+)\b/m);
      if (m) return m[1];
    }
    if (toolName === "shellcheck") {
      const m = text.match(/^version:\s*v?([0-9]+\.[0-9]+\.[0-9]+)\b/m);
      if (m) return m[1];
    }
    const generic = text.match(/(?:^|[\s:v])([0-9]+\.[0-9]+\.[0-9]+(?:[+-][0-9A-Za-z.-]+)?)(?:[\s,)]|$)/);
    if (generic) return generic[1];
  }
  return "";
}

function isInsideDirectory(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

function executableInCacheVersionDir(cacheRoot, toolName, version, arch, platform) {
  const exe = platform === "win32" ? `${toolName}.exe` : toolName;
  const base = path.join(cacheRoot, toolName, version, arch);
  for (const candidate of [path.join(base, exe), path.join(base, "bin", exe)]) {
    if (!existsSync(candidate)) continue;
    try {
      const resolved = realpathSync(candidate);
      if (!isInsideDirectory(resolved, cacheRoot)) continue;
      const stat = statSync(resolved);
      if (stat.isFile()) return resolved;
    } catch {
      continue;
    }
  }
  return "";
}

export function findManagedTool(toolName, {
  environment = process.env,
  snapshot = null,
  requestedVersion = "",
  allowPathOutsideCache = false,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  let acceptedVersions = null;
  let preferredVersion = requestedVersion;
  if (snapshot) {
    const resolved = toolName === "just"
      ? resolveToolchain(snapshot, "just", requestedVersion)
      : resolveTool(snapshot, toolName, requestedVersion);
    acceptedVersions = resolved.acceptedVersions;
    preferredVersion = requestedVersion || resolved.version;
  } else if (requestedVersion) {
    acceptedVersions = [requestedVersion];
  }

  const rawCache = (environment.RUNNER_TOOL_CACHE ?? "").trim();
  let cacheReal = "";
  if (rawCache) {
    if (!path.isAbsolute(rawCache) || /[\r\n\0]/.test(rawCache)) {
      throw new ActionError("The managed RUNNER_TOOL_CACHE must be an absolute path.");
    }
    if (existsSync(rawCache)) cacheReal = realpathSync(rawCache);
  }

  if (cacheReal) {
    const toolDir = path.join(cacheReal, toolName);
    if (existsSync(toolDir)) {
      const installed = readdirSync(toolDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(compareVersionsDesc);
      const candidates = [];
      if (preferredVersion && installed.includes(preferredVersion)) candidates.push(preferredVersion);
      for (const ver of installed) {
        if (candidates.includes(ver)) continue;
        if (acceptedVersions && !acceptedVersions.includes(ver)) continue;
        candidates.push(ver);
      }
      for (const ver of candidates) {
        const binary = executableInCacheVersionDir(cacheReal, toolName, ver, arch, platform);
        if (!binary) continue;
        const measured = measureToolVersion(binary, toolName, environment);
        if (!measured) continue;
        if (acceptedVersions && !acceptedVersions.includes(measured)) continue;
        if (measured !== ver && !measured.startsWith(`${ver}+`)) continue;
        return { binary, version: measured, source: "tool-cache" };
      }
    }
  }

  // Fallback: inspect PATH for a verified tool inside RUNNER_TOOL_CACHE (or PATH for just when allowed).
  const exe = platform === "win32" ? `${toolName}.exe` : toolName;
  const pathValue = environment.PATH ?? environment.Path ?? "";
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, exe);
    if (!existsSync(candidate)) continue;
    let resolved;
    try {
      resolved = realpathSync(candidate);
      if (!statSync(resolved).isFile()) continue;
    } catch {
      continue;
    }
    if (!allowPathOutsideCache) {
      if (!cacheReal || !isInsideDirectory(resolved, cacheReal)) continue;
    }
    const measured = measureToolVersion(resolved, toolName, environment);
    if (!measured) continue;
    if (acceptedVersions && !acceptedVersions.includes(measured)) continue;
    return { binary: resolved, version: measured, source: cacheReal && isInsideDirectory(resolved, cacheReal) ? "tool-cache" : "path" };
  }

  const expectation = acceptedVersions ? ` matching ${acceptedVersions.join(", ")}` : "";
  throw new ActionError(`The managed runner does not provide a verified ${toolName}${expectation}.`);
}

// Kind 3: image (covers OCI base images across image, toolchain and service registry kinds).
const imageRepoAliases = Object.freeze({
  "alpine": "alpine",
  "debian": "debian",
  "busybox": "busybox",
  "almalinux": "almalinux",
  "nvidia/cuda": "cuda",
  "nginx/nginx-unprivileged": "nginx/nginx-unprivileged",
  "docker/dockerfile": "dockerfile-frontend",
  "moby/buildkit": "buildkit",
  "nginxproxy/nginx-proxy": "nginx-proxy",
  "nginxproxy/acme-companion": "acme-companion",
  "jenkins/inbound-agent": "jenkins-inbound-agent",
  "confluentinc/cp-kafka": "confluent-platform",
  "ubuntu": "ubuntu",
  "rust": "rust",
  "node": "node",
  "python": "python",
  "golang": "go",
  "oven/bun": "bun",
  "eclipse-temurin": "jdk",
  "ghcr.io/astral-sh/uv": "uv",
  "mcr.microsoft.com/dotnet/sdk": "dotnet",
  "mcr.microsoft.com/dotnet/aspnet": "dotnet",
  "mcr.microsoft.com/dotnet/runtime": "dotnet",
  "mcr.microsoft.com/dotnet/runtime-deps": "dotnet",
  "php": "php",
  "ruby": "ruby",
  "swift": "swift",
  "gradle": "gradle",
  "maven": "maven",
  "gcc": "gcc",
  "mcr.microsoft.com/playwright": "playwright",
  "timberio/vector": "vector",
  "postgres": "postgresql",
  "pgvector/pgvector": "pgvector",
  "redis": "redis",
  "valkey/valkey": "valkey",
  "mariadb": "mariadb",
  "nginx": "nginx",
  "caddy": "caddy",
  "clickhouse/clickhouse-server": "clickhouse",
  "grafana/grafana": "grafana",
  "grafana/loki": "loki",
  "prom/prometheus": "prometheus",
  "rabbitmq": "rabbitmq",
  "qdrant/qdrant": "qdrant",
  "mcr.microsoft.com/mssql/server": "sql-server",
  "minio/minio": "minio-server",
  "neo4j": "neo4j-server",
  "axllent/mailpit": "mailpit",
  "mailhog/mailhog": "mailhog",
  "getmeili/meilisearch": "meilisearch",
  "openobserve/openobserve": "openobserve",
  "public.ecr.aws/zinclabs/openobserve": "openobserve",
  "temporalio/auto-setup": "temporal",
  "temporalio/server": "temporal",
  "temporalio/ui": "temporal-ui",
  "localstack/localstack": "localstack",
  "ghcr.io/rustfs/rustfs": "rustfs",
  "rustfs/rustfs": "rustfs",
  "vllm/vllm-openai": "vllm",
  "livekit/livekit-server": "livekit-server",
  "livekit/egress": "livekit-egress",
  "apache/airflow": "airflow",
  "influxdb": "influxdb",
  "jenkins/jenkins": "jenkins",
  "clamav/clamav": "clamav",
  "cloudflare/cloudflared": "cloudflared",
  "gcr.io/datadoghq/agent": "datadog-agent",
  "datadog/agent": "datadog-agent",
  "ghcr.io/open-feature/flagd": "flagd",
  "docker.elastic.co/logstash/logstash": "logstash",
  "ubuntu/squid": "squid",
});

export function parseImageReference(reference) {
  const raw = String(reference ?? "").trim();
  if (!raw || /[\s\0]/.test(raw)) {
    throw new ActionError(`Malformed OCI image reference: ${JSON.stringify(reference)}.`);
  }
  let withoutDigest = raw;
  let digest = "";
  const atIndex = raw.indexOf("@");
  if (atIndex !== -1) {
    withoutDigest = raw.slice(0, atIndex);
    digest = raw.slice(atIndex + 1);
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new ActionError(`OCI image reference has a malformed digest: ${raw}.`);
    }
  }
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  let repository = withoutDigest;
  let tag = "";
  if (lastColon > lastSlash) {
    repository = withoutDigest.slice(0, lastColon);
    tag = withoutDigest.slice(lastColon + 1);
    if (!tag) throw new ActionError(`OCI image reference has an empty tag: ${raw}.`);
  }
  if (!repository) throw new ActionError(`OCI image reference has no repository: ${raw}.`);
  return { raw, repository, tag, digest };
}

function imageRegistryKey(parsed) {
  const repo = parsed.repository.toLowerCase();
  if (repo.startsWith("gcr.io/distroless/")) {
    const imageName = repo.slice("gcr.io/distroless/".length);
    const releaseMatch = /-([a-z]+\d+)$/.exec(imageName);
    return {
      key: "distroless",
      kindCandidates: ["image"],
      effectiveVersion: releaseMatch ? releaseMatch[1] : "",
      tagTransform: (t) => t.replace(/^[a-z0-9_]+-/, ""),
    };
  }
  const bare = repo.replace(/^docker\.io\/library\//, "").replace(/^docker\.io\//, "");
  const key = Object.hasOwn(imageRepoAliases, bare) ? imageRepoAliases[bare] : bare;
  return { key, kindCandidates: ["image", "toolchain", "service"], effectiveVersion: "", tagTransform: (t) => t };
}

function imageTagMatchesAccepted(tag, acceptedVersions, transform) {
  const cleaned = transform(tag).replace(/^v(?=\d)/, "");
  for (const accepted of acceptedVersions) {
    const normalized = accepted.replace(/^v(?=\d)/, "");
    if (cleaned === normalized) return true;
    // Allow variant suffixes such as 3.24.4-alpine, 13.8-slim, 25.0.5.1_1-jdk, static-debian13.
    if (cleaned.startsWith(`${normalized}-`) || cleaned.startsWith(`${normalized}_`) ||
        tag === accepted || tag.endsWith(`-${normalized}`)) return true;
  }
  return false;
}

export function resolveImage(snapshot, name, requestedTag = "") {
  const allowedKinds = name === "buildkit" ? ["image", "toolchain"] : ["image"];
  const entry = lookupTechnology(snapshot, [name], allowedKinds, `image ${name}`);
  if (requestedTag) {
    if (!imageTagMatchesAccepted(requestedTag, entry.acceptedVersions, (v) => v)) {
      throw new ActionError(
        `Image ${name} tag ${requestedTag} is outside the snapshot's accepted lines (${entry.acceptedVersions.join(", ")}).`,
      );
    }
    return { ...entry, version: requestedTag };
  }
  if (!entry.latest) {
    throw new ActionError(`Image ${name} has no single latest line in the registry snapshot.`);
  }
  return { ...entry, version: entry.latest.version };
}

export function checkImageReference(snapshot, reference) {
  const parsed = parseImageReference(reference);
  const { key, kindCandidates, effectiveVersion, tagTransform } = imageRegistryKey(parsed);
  const versionToken = effectiveVersion || parsed.tag;
  if (!versionToken || parsed.tag === "latest") {
    throw new ActionError(`OCI image reference must pin a version tag (not latest): ${parsed.raw}.`);
  }
  const entry = lookupTechnology(snapshot, [key], kindCandidates, `image ${key} (from ${parsed.raw})`);
  if (!imageTagMatchesAccepted(versionToken, entry.acceptedVersions, tagTransform)) {
    throw new ActionError(
      `Image ${parsed.raw} (key ${key}, tag ${versionToken}) is outside the snapshot's accepted lines (${entry.acceptedVersions.join(", ")}).`,
    );
  }
  return { ...parsed, key, acceptedVersions: entry.acceptedVersions };
}

export function checkHostedRunnerImage(snapshot, label) {
  const entry = lookupTechnology(snapshot, ["actions/runner-images"], ["image"], "image actions/runner-images");
  if (!entry.acceptedVersions.includes(label)) {
    throw new ActionError(
      `Hosted runner image ${label} is outside the snapshot's accepted lines (${entry.acceptedVersions.join(", ")}).`,
    );
  }
  return { label, acceptedVersions: entry.acceptedVersions };
}

export function checkDockerfileImages(snapshot, dockerfileContent, buildArgs = {}) {
  const args = { ...buildArgs };
  const stages = new Set(["scratch"]);
  const checked = [];
  const violations = [];
  const lines = String(dockerfileContent ?? "").replace(/\r\n/g, "\n").split("\n");

  const substitute = (value) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, bare) => {
      const name = braced ?? bare;
      return Object.hasOwn(args, name) ? String(args[name]) : match;
    });

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    const lineNo = i + 1;
    if (i === 0) {
      const syntax = /^#\s*syntax\s*=\s*(\S+)/i.exec(rawLine);
      if (syntax) {
        try {
          checked.push({ line: lineNo, directive: "syntax", ...checkImageReference(snapshot, syntax[1]) });
        } catch (error) {
          violations.push({ line: lineNo, directive: "syntax", reference: syntax[1], reason: error.message });
        }
        continue;
      }
    }
    if (!rawLine || rawLine.startsWith("#")) continue;

    const argMatch = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/i.exec(rawLine);
    if (argMatch) {
      const [, argName, defaultVal] = argMatch;
      if (!Object.hasOwn(args, argName) && defaultVal !== undefined) {
        args[argName] = defaultVal.trim().replace(/^["']|["']$/g, "");
      }
      continue;
    }

    const fromMatch = /^FROM\s+(?:--platform=\S+\s+)*(\S+)(?:\s+AS\s+([A-Za-z0-9_.-]+))?/i.exec(rawLine);
    if (!fromMatch) continue;
    const rawRef = substitute(fromMatch[1]);
    const stageName = fromMatch[2]?.toLowerCase() ?? "";
    if (stages.has(rawRef.toLowerCase())) {
      if (stageName) stages.add(stageName);
      continue;
    }
    if (stageName) stages.add(stageName);
    try {
      checked.push({ line: lineNo, directive: "FROM", ...checkImageReference(snapshot, rawRef) });
    } catch (error) {
      violations.push({ line: lineNo, directive: "FROM", reference: rawRef, reason: error.message });
    }
  }
  return { checked, violations };
}

// Kind 4: action
export function normalizeActionRepository(usesTarget) {
  const parts = String(usesTarget ?? "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new ActionError(`Malformed GitHub Action reference: ${JSON.stringify(usesTarget)}.`);
  }
  return `${parts[0]}/${parts[1]}`;
}

export function resolveAction(snapshot, actionSpec, requestedRef = "") {
  const repo = normalizeActionRepository(actionSpec);
  const entry = lookupTechnology(snapshot, [repo], ["action"], `action ${repo}`);
  const commitLines = entry.lines.filter((line) => fullCommitPattern.test(line.commit));
  if (commitLines.length === 0) {
    throw new ActionError(`Registry action ${repo} declares no pinned commit SHA.`);
  }
  const acceptedCommits = commitLines.map((line) => line.commit);
  if (requestedRef) {
    const matched = fullCommitPattern.test(requestedRef)
      ? commitLines.find((line) => line.commit === requestedRef)
      : commitLines.find((line) => line.version === requestedRef);
    if (!matched) {
      throw new ActionError(
        `Action ${repo}@${requestedRef} is outside the snapshot's accepted commits (${acceptedCommits.join(", ")}).`,
      );
    }
    return {
      key: entry.key,
      name: repo,
      version: matched.version,
      commit: matched.commit,
      ref: `${actionSpec}@${matched.commit}`,
      acceptedCommits,
      acceptedVersions: entry.acceptedVersions,
    };
  }
  const primary = entry.latest && fullCommitPattern.test(entry.latest.commit) ? entry.latest : commitLines[0];
  return {
    key: entry.key,
    name: repo,
    version: primary.version,
    commit: primary.commit,
    ref: `${actionSpec}@${primary.commit}`,
    acceptedCommits,
    acceptedVersions: entry.acceptedVersions,
  };
}

export function checkWorkflowActions(snapshot, files) {
  const checked = [];
  const violations = [];
  for (const file of files) {
    const lines = String(file.content ?? "").replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = /^\s*(?:-\s+)?uses:\s*['"]?([^\s'"#]+)['"]?/.exec(lines[i]);
      if (!match) continue;
      const uses = match[1];
      if (uses.startsWith("./") || uses.startsWith("$/") || uses.startsWith("docker://")) continue;
      const at = uses.indexOf("@");
      if (at === -1) {
        violations.push({ path: file.path, line: i + 1, uses, reason: "Action reference has no @commit pin." });
        continue;
      }
      const target = uses.slice(0, at);
      const ref = uses.slice(at + 1);
      // Skip reusable workflow calls (owner/repo/.github/workflows/*.yml@sha).
      if (target.includes("/.github/workflows/")) continue;
      if (!fullCommitPattern.test(ref)) {
        violations.push({ path: file.path, line: i + 1, uses, reason: `Action pin ${ref} is not a 40-character commit SHA.` });
        continue;
      }
      try {
        const resolved = resolveAction(snapshot, target, ref);
        checked.push({ path: file.path, line: i + 1, uses, action: resolved.name, version: resolved.version, commit: resolved.commit });
      } catch (error) {
        violations.push({ path: file.path, line: i + 1, uses, reason: error.message });
      }
    }
  }
  return { checked, violations };
}

// Materializes a GitHub Action at the exact commit SHA resolved from the registry snapshot,
// verifying the checked-out HEAD matches the snapshot's pinned commit.
export function prepareActionFromRegistry(snapshot, actionSpec, destination, {
  sourceUrl = "",
  requestedRef = "",
  environment = process.env,
} = {}) {
  const resolved = resolveAction(snapshot, actionSpec, requestedRef);
  const remote = sourceUrl || `https://github.com/${resolved.name}.git`;
  mkdirSync(destination, { recursive: true });
  const gitEnv = { ...environment, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" };
  const runGit = (args) => {
    const res = spawnSync("git", args, { cwd: destination, env: gitEnv, encoding: "utf8", timeout: 60000 });
    if (res.error || res.status !== 0) {
      throw new ActionError(`Could not materialize action ${resolved.ref}: ${(res.stderr || "").trim()}`);
    }
    return res.stdout.trim();
  };
  runGit(["init", "--quiet"]);
  runGit(["remote", "add", "origin", remote]);
  runGit(["fetch", "--quiet", "--depth", "1", "origin", resolved.commit]);
  runGit(["checkout", "--quiet", "--detach", resolved.commit]);
  const head = runGit(["rev-parse", "HEAD"]);
  if (head !== resolved.commit) {
    throw new ActionError(`Materialized action commit ${head} differs from snapshot commit ${resolved.commit}.`);
  }
  return { ...resolved, directory: destination };
}

export function isSemverVersion(value) {
  return semverCorePattern.test(value ?? "");
}
