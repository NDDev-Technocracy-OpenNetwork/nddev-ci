// Content-addressed OCI artifact transfer on GHCR for private repositories.
// Each artifact is stored as one OCI Image Manifest v1 under <owner>/<repo>/ci-artifacts,
// tagged by run attempt and verified by digest and exact source/run/attempt annotations.
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ReleaseError, artifactNames, limits } from "./release.mjs";

export const ociManifestMediaType = "application/vnd.oci.image.manifest.v1+json";
export const ociArtifactType = "application/vnd.nddev.ci.artifact.v1";
export const ociEmptyMediaType = "application/vnd.oci.empty.v1+json";
export const defaultRegistryUrl = "https://ghcr.io";

const emptyBlob = Buffer.from("{}");
const emptyDigest = `sha256:${createHash("sha256").update(emptyBlob).digest("hex")}`;
// GHCR rejects chunked PATCH requests with Content-Range bodies larger than 4 MiB with HTTP 416.
const monolithicLimitBytes = 4 * 1024 * 1024;
export const defaultChunkBytes = 4 * 1024 * 1024;
const maxManifestBytes = 4 * 1024 * 1024;
const maxErrorBodyBytes = 8192;
const ociErrorCodePattern = /^[A-Z0-9_]{1,64}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

const transientTransportCodes = new Set([
  "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);
const permanentTransportCodes = new Set([
  "ENOTFOUND", "ECONNREFUSED", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const transientStatuses = new Set([502, 503, 504]);

const refuse = (message) => {
  throw new ReleaseError(message);
};
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

function registryOriginUrl(value = defaultRegistryUrl) {
  let url;
  try { url = new URL(value || defaultRegistryUrl); } catch { refuse("Invalid declared OCI registry URL."); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/" || /[\r\n\0]/.test(value ?? ""))
    refuse("OCI registry URLs require HTTPS without path, query, credentials or fragments.");
  return url;
}

function redirectUrl(location, base) {
  let url;
  try { url = new URL(location, base); } catch { refuse("OCI registry returned a malformed redirect."); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.hash || /[\r\n\0]/.test(location ?? ""))
    refuse("OCI storage redirects require HTTPS without credentials or fragments.");
  return url;
}

export function repositoryIsPrivate(environment = process.env) {
  if (environment.INPUT_PRIVATE === "true") return true;
  if (environment.INPUT_PRIVATE === "false") return false;
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (!eventPath) return false;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch {
    refuse("The workflow event payload could not be read to determine repository visibility.");
  }
  return parsed?.repository?.private === true;
}

export function packageName(repository) {
  if (!repoPattern.test(repository ?? "")) refuse("OCI artifact transfer requires an exact owner/repository.");
  return `${repository.toLowerCase()}/ci-artifacts`;
}

export function artifactTag(runId, runAttempt, name) {
  const id = Number(runId);
  const attempt = Number(runAttempt);
  if (!positive(id) || !positive(attempt)) refuse("OCI artifact tags require positive run and attempt IDs.");
  const [checked] = artifactNames(name);
  if (!checked) refuse("OCI artifact tags require a plain artifact name.");
  return `r${id}-a${attempt}-${sha256Hex(checked).slice(0, 16)}`;
}

function validateTitle(title, topLevelOnly) {
  if (typeof title !== "string" || !title || title.startsWith("/") || title.endsWith("/") || title.includes("\\"))
    refuse(`Artifact entry ${JSON.stringify(title)} has an unsafe path.`);
  const parts = title.split("/");
  if (topLevelOnly && parts.length !== 1)
    refuse(`Artifact entry ${JSON.stringify(title)} must be a top-level file.`);
  for (const part of parts) {
    if (!segmentPattern.test(part)) refuse(`Artifact entry ${JSON.stringify(title)} has an invalid file name.`);
  }
  return parts.join("/");
}

function withinRoots(candidate, roots) {
  for (const root of roots) {
    if (candidate === root || candidate.startsWith(root + path.sep)) return root;
  }
  refuse("Artifact paths must stay inside the job workspace or temporary directory.");
}

function assertNoSymlinkPrefix(root, target) {
  const relative = path.relative(root, target);
  if (!relative) return;
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) refuse("Artifact paths cannot traverse symbolic links.");
  }
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function walkRegularFiles(dir, root, found) {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) refuse("Artifact directories cannot contain symbolic links.");
    if (stat.isDirectory()) walkRegularFiles(full, root, found);
    else if (stat.isFile()) found.push({ full, root, stat });
    else refuse("Artifact directories can contain only regular files.");
  }
}

function commonDirectory(directories) {
  const split = directories.map((dir) => dir.split(path.sep));
  const prefix = [];
  for (let index = 0; index < split[0].length; index++) {
    const part = split[0][index];
    if (split.every((parts) => parts[index] === part)) prefix.push(part);
    else break;
  }
  return prefix.join(path.sep) || path.sep;
}

export async function collectFiles(pathsText, { cwd, allowedRoots, topLevelOnly = false }) {
  const rootPairs = allowedRoots.filter(Boolean).map((root) => ({
    raw: path.resolve(root),
    real: realpathSync(root),
  }));
  const work = realpathSync(cwd);
  if (!rootPairs.some((pair) => pair.real === work)) rootPairs.push({ raw: path.resolve(cwd), real: work });
  const roots = [...new Set(rootPairs.map((pair) => pair.real))];
  const normalizeRootPrefix = (candidate) => {
    for (const pair of rootPairs) {
      if (pair.raw !== pair.real && (candidate === pair.raw || candidate.startsWith(pair.raw + path.sep)))
        return path.join(pair.real, path.relative(pair.raw, candidate));
    }
    return candidate;
  };
  const rawLines = (pathsText ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!rawLines.length) refuse("At least one artifact path must be named.");

  const matchedEntries = [];
  for (const raw of rawLines) {
    const unsafeBackslash = process.platform !== "win32" && raw.includes("\\");
    if (unsafeBackslash || raw.split(/[\\/]/).includes(".."))
      refuse(`Artifact path ${JSON.stringify(raw)} escapes its workspace.`);
    const hasGlob = /[*?[\]{}]/.test(raw);
    let targets;
    if (hasGlob) {
      if (path.isAbsolute(raw)) refuse("Glob artifact patterns must stay relative to the workspace.");
      targets = globSync(raw, { cwd: work }).sort().map((match) => path.resolve(work, match));
    } else {
      const resolved = normalizeRootPrefix(path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(work, raw));
      targets = existsSync(resolved) ? [resolved] : [];
    }
    for (const target of targets) {
      const root = withinRoots(target, roots);
      assertNoSymlinkPrefix(root, target);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) refuse("Artifact paths cannot include symbolic links.");
      if (stat.isDirectory()) matchedEntries.push({ kind: "dir", full: target, root });
      else if (stat.isFile()) matchedEntries.push({ kind: "file", full: target, root, stat });
      else refuse("Artifact paths can include only regular files and directories.");
    }
  }
  if (!matchedEntries.length) refuse("No files matched the declared artifact path.");

  const collected = [];
  if (matchedEntries.length === 1 && matchedEntries[0].kind === "dir") {
    const base = matchedEntries[0].full;
    const files = [];
    walkRegularFiles(base, matchedEntries[0].root, files);
    for (const item of files) collected.push({ ...item, title: path.relative(base, item.full).split(path.sep).join("/") });
  } else {
    const files = [];
    for (const entry of matchedEntries) {
      if (entry.kind === "file") files.push(entry);
      else walkRegularFiles(entry.full, entry.root, files);
    }
    const dedup = new Map();
    for (const item of files) dedup.set(item.full, item);
    const unique = [...dedup.values()].sort((a, b) => (a.full < b.full ? -1 : 1));
    const base = unique.length === 1
      ? path.dirname(unique[0].full)
      : commonDirectory(unique.map((item) => path.dirname(item.full)));
    for (const item of unique) collected.push({ ...item, title: path.relative(base, item.full).split(path.sep).join("/") });
  }

  if (!collected.length) refuse("No files matched the declared artifact path.");
  if (collected.length > limits.files) refuse("The artifact holds too many files.");

  const seen = new Set();
  let total = 0;
  const result = [];
  for (const item of collected) {
    const title = validateTitle(item.title, topLevelOnly);
    const folded = title.toLowerCase();
    if (seen.has(folded)) refuse(`Two artifact entries share the name ${title}.`);
    seen.add(folded);
    if ((topLevelOnly ? !positive(item.stat.size) : (!Number.isSafeInteger(item.stat.size) || item.stat.size < 0)) ||
        item.stat.size > limits.fileBytes)
      refuse(`Artifact file ${title} is empty or exceeds the maximum file size.`);
    total += item.stat.size;
    if (total > limits.totalBytes) refuse("The artifact files exceed their total size bound.");
    const sha256 = await hashFile(item.full);
    result.push({
      title,
      path: item.full,
      size: item.stat.size,
      sha256,
      digest: `sha256:${sha256}`,
      executable: (item.stat.mode & 0o111) !== 0,
    });
  }
  return result.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}

export async function retryableFetch(request, {
  retry = false,
  timeout = 60000,
  consume,
  shouldRetryResponse = (response) => transientStatuses.has(response.status) && !response.headers.has("retry-after"),
  onUnretriedError = () => refuse("The OCI registry transport did not complete."),
  onExhausted = (attempt, cause) => refuse(`The OCI registry read failed after ${attempt} attempt${attempt === 1 ? "" : "s"} (${cause}).`),
} = {}) {
  const attempts = retry ? 3 : 1;
  const deadline = performance.now() + timeout;
  for (let attempt = 1; ; attempt++) {
    const remaining = Math.max(1, Math.floor(deadline - performance.now()));
    // Reads that consume the response here leave time for another complete attempt.
    // A caller that receives a raw response keeps the rest of its original budget.
    const budget = retry && consume && attempt < attempts ? Math.ceil(remaining / 2) : retry ? remaining : timeout;
    const signal = AbortSignal.timeout(Math.max(1, budget));
    let cause;
    let transient = false;
    try {
      const response = await request(signal);
      if (!retry || !shouldRetryResponse(response)) return consume ? await consume(response) : response;
      cause = `HTTP ${response.status}`;
      transient = true;
      await response.body?.cancel();
    } catch (error) {
      if (error instanceof ReleaseError) throw error;
      if (!retry) onUnretriedError();
      const code = error.cause?.code ?? error.code;
      transient = signal.aborted || transientTransportCodes.has(code);
      cause = signal.aborted ? "request timeout"
        : transient || permanentTransportCodes.has(code) ? code : "unclassified transport error";
    }
    const backoff = 250 * attempt;
    if (!transient || attempt >= attempts || performance.now() + backoff >= deadline) onExhausted(attempt, cause);
    await delay(backoff);
  }
}

async function fetchWithRetry(url, options, { retryReads = false, timeout = 60000 } = {}, consume) {
  const retry = retryReads && (options.method ?? "GET") === "GET" && options.body === undefined;
  return retryableFetch((signal) => fetch(url, { ...options, redirect: "manual", signal }), { retry, timeout, consume });
}

async function registryBearer({ origin, pkg, actions, token, actor, retryReads }) {
  if (!token) refuse("A GitHub token is required for OCI artifact transfer.");
  const credentials = Buffer.from(`${actor || "x-access-token"}:${token}`).toString("base64");
  const service = origin.hostname;
  const tokenUrl = `${origin.origin}/token?service=${encodeURIComponent(service)}&scope=${encodeURIComponent(`repository:${pkg}:${actions}`)}`;
  const needed = actions.includes("push") ? "packages: write" : "packages: read";
  return fetchWithRetry(tokenUrl, {
    method: "GET",
    headers: { Authorization: `Basic ${credentials}`, Accept: "application/json", "User-Agent": "nddev-ci" },
  }, { retryReads, timeout: 60000 }, async (response) => {
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      refuse(`GHCR refused ${actions} access for ${pkg}. Ensure the workflow grants ${needed}.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      refuse(`GHCR token exchange failed with HTTP ${response.status}.`);
    }
    let body;
    try { body = await response.json(); } catch { refuse("GHCR token exchange returned malformed JSON."); }
    const bearer = body?.token || body?.access_token;
    if (typeof bearer !== "string" || !bearer) refuse("GHCR token exchange returned no bearer token.");
    return bearer;
  });
}

async function ociErrorSuffix(response) {
  if (!response.body) return "";
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxErrorBodyBytes) {
        await response.body.cancel();
        return "";
      }
      chunks.push(chunk);
    }
    const code = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.errors?.[0]?.code;
    return typeof code === "string" && ociErrorCodePattern.test(code) ? ` (${code})` : "";
  } catch {
    return "";
  }
}

async function refusePushResponse(response, pkg, action) {
  const detail = await ociErrorSuffix(response);
  if (response.status === 401 || response.status === 403)
    refuse(`GHCR refused push access for ${pkg}. Ensure the workflow grants packages: write.`);
  refuse(`GHCR ${action} failed with HTTP ${response.status}${detail}.`);
}

async function uploadBlob({ origin, pkg, bearer, digest, size, source, chunkBytes = defaultChunkBytes }) {
  if (!positive(chunkBytes)) refuse("OCI blob chunk size must be a positive integer.");
  const head = await fetchWithRetry(`${origin.origin}/v2/${pkg}/blobs/${digest}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${bearer}`, "User-Agent": "nddev-ci" },
  }, { timeout: 60000 });
  if (head.status === 200) { await head.body?.cancel(); return; }
  if (head.status !== 404) await refusePushResponse(head, pkg, "blob existence check");
  await head.body?.cancel();

  const start = await fetchWithRetry(`${origin.origin}/v2/${pkg}/blobs/uploads/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Length": "0", "User-Agent": "nddev-ci" },
  }, { timeout: 60000 });
  const location = start.headers.get("location");
  if (start.status !== 202) await refusePushResponse(start, pkg, "blob upload session");
  await start.body?.cancel();
  if (!location) refuse("GHCR blob upload session returned no location.");
  let uploadUrl = redirectUrl(location, origin.origin);
  if (uploadUrl.origin !== origin.origin) refuse("OCI blob upload credentials cannot leave the registry origin.");

  const monolithicCeiling = Buffer.isBuffer(source) ? monolithicLimitBytes : Math.min(chunkBytes, monolithicLimitBytes);
  if (size <= monolithicCeiling) {
    const sep = uploadUrl.search ? "&" : "?";
    const finalize = `${uploadUrl.href}${sep}digest=${encodeURIComponent(digest)}`;
    const body = Buffer.isBuffer(source) ? source : readFileSync(source);
    if (body.length !== size) refuse("Artifact file changed size during OCI upload.");
    const put = await fetchWithRetry(finalize, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        "User-Agent": "nddev-ci",
      },
      body,
    }, { timeout: 900000 });
    const blobDigest = put.headers.get("docker-content-digest");
    if (put.status !== 201) await refusePushResponse(put, pkg, "blob upload");
    await put.body?.cancel();
    if (blobDigest && blobDigest !== digest) refuse("GHCR recorded a different blob digest.");
    return;
  }

  // Stream large blobs in bounded chunks so GHCR stays within its 4 MiB Content-Range PATCH limit.
  const fd = openSync(source, "r");
  try {
    let offset = 0;
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, size));
    while (offset < size) {
      const length = Math.min(chunkBytes, size - offset);
      let read = 0;
      while (read < length) {
        const bytes = readSync(fd, buffer, read, length - read, offset + read);
        if (bytes === 0) refuse("Artifact file shrank during OCI upload.");
        read += bytes;
      }
      const slice = read === buffer.length ? buffer : buffer.subarray(0, read);
      const expectedEnd = offset + read - 1;
      const patch = await fetchWithRetry(uploadUrl.href, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(read),
          "Content-Range": `${offset}-${expectedEnd}`,
          "User-Agent": "nddev-ci",
        },
        body: slice,
      }, { timeout: 900000 });
      const next = patch.headers.get("location");
      const range = patch.headers.get("range");
      if (patch.status !== 202) await refusePushResponse(patch, pkg, "chunked blob upload");
      await patch.body?.cancel();
      if (range && range !== `0-${expectedEnd}`)
        refuse(`GHCR chunked blob upload recorded an unexpected range (expected 0-${expectedEnd}).`);
      if (next) {
        uploadUrl = redirectUrl(next, uploadUrl.href);
        if (uploadUrl.origin !== origin.origin) refuse("OCI blob upload credentials cannot leave the registry origin.");
      }
      offset += read;
    }
  } finally {
    closeSync(fd);
  }
  const sep = uploadUrl.search ? "&" : "?";
  const put = await fetchWithRetry(`${uploadUrl.href}${sep}digest=${encodeURIComponent(digest)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Length": "0", "User-Agent": "nddev-ci" },
  }, { timeout: 300000 });
  const blobDigest = put.headers.get("docker-content-digest");
  if (put.status !== 201) await refusePushResponse(put, pkg, "chunked blob commit");
  await put.body?.cancel();
  if (blobDigest && blobDigest !== digest) refuse("GHCR recorded a different blob digest.");
}

export async function pushOciArtifact({
  repository,
  sha,
  branch = "",
  runId,
  runAttempt,
  name,
  part = "",
  pathsText,
  cwd,
  allowedRoots,
  topLevelOnly = false,
  token,
  actor = "x-access-token",
  registryUrl = defaultRegistryUrl,
  chunkBytes = defaultChunkBytes,
}) {
  if (!shaPattern.test(sha ?? "")) refuse("OCI artifact push requires a full 40-character source commit SHA.");
  const origin = registryOriginUrl(registryUrl);
  const pkg = packageName(repository);
  const tag = artifactTag(runId, runAttempt, name);
  const files = await collectFiles(pathsText, { cwd, allowedRoots, topLevelOnly });
  const bearer = await registryBearer({ origin, pkg, actions: "pull,push", token, actor, retryReads: false });

  // Refuse duplicate uploads under the same artifact name within one attempt.
  const existing = await fetchWithRetry(`${origin.origin}/v2/${pkg}/manifests/${tag}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${bearer}`, Accept: ociManifestMediaType, "User-Agent": "nddev-ci" },
  }, { timeout: 60000 });
  if (existing.status === 200) {
    await existing.body?.cancel();
    refuse(`Artifact ${name} was already uploaded in run ${runId} attempt ${runAttempt}.`);
  }
  if (existing.status !== 404) await refusePushResponse(existing, pkg, "manifest check");
  await existing.body?.cancel();

  await uploadBlob({ origin, pkg, bearer, digest: emptyDigest, size: emptyBlob.length, source: emptyBlob, chunkBytes });
  const uploaded = new Set([emptyDigest]);
  for (const file of files) {
    if (uploaded.has(file.digest)) continue;
    await uploadBlob({ origin, pkg, bearer, digest: file.digest, size: file.size, source: file.path, chunkBytes });
    uploaded.add(file.digest);
  }

  const writerId = randomUUID();
  const manifest = {
    schemaVersion: 2,
    mediaType: ociManifestMediaType,
    artifactType: ociArtifactType,
    config: { mediaType: ociEmptyMediaType, digest: emptyDigest, size: emptyBlob.length },
    layers: files.map((file) => ({
      mediaType: "application/octet-stream",
      digest: file.digest,
      size: file.size,
      annotations: {
        "org.opencontainers.image.title": file.title,
        ...(file.executable ? { "org.nddev.ci.executable": "true" } : {}),
      },
    })),
    annotations: {
      "org.opencontainers.image.source": `https://github.com/${repository}`,
      "org.opencontainers.image.revision": sha,
      "org.nddev.ci.repository": repository,
      "org.nddev.ci.sha": sha,
      "org.nddev.ci.branch": branch,
      "org.nddev.ci.run_id": String(runId),
      "org.nddev.ci.run_attempt": String(runAttempt),
      "org.nddev.ci.artifact_name": name,
      "org.nddev.ci.created_at": new Date().toISOString(),
      "org.nddev.ci.writer_id": writerId,
      ...(part ? { "org.nddev.ci.part": part } : {}),
    },
  };
  const body = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const digest = `sha256:${sha256Hex(body)}`;

  const put = await fetchWithRetry(`${origin.origin}/v2/${pkg}/manifests/${tag}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": ociManifestMediaType,
      "Content-Length": String(body.length),
      "User-Agent": "nddev-ci",
    },
    body,
  }, { timeout: 60000 });
  const serverDigest = put.headers.get("docker-content-digest");
  if (put.status !== 201) await refusePushResponse(put, pkg, "manifest push");
  await put.body?.cancel();
  if (serverDigest && serverDigest !== digest) refuse("GHCR recorded a different manifest digest.");

  // Confirm no concurrent matrix job overwrote the same attempt tag during publication.
  const verify = await fetchWithRetry(`${origin.origin}/v2/${pkg}/manifests/${tag}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${bearer}`, Accept: ociManifestMediaType, "User-Agent": "nddev-ci" },
  }, { timeout: 60000 });
  const verifiedBytes = Buffer.from(await verify.arrayBuffer());
  if (!verify.ok || `sha256:${sha256Hex(verifiedBytes)}` !== digest)
    refuse(`Artifact ${name} changed concurrently during upload.`);
  const parsed = JSON.parse(verifiedBytes.toString("utf8"));
  if (parsed?.annotations?.["org.nddev.ci.writer_id"] !== writerId)
    refuse(`Artifact ${name} was overwritten by another job of this attempt.`);

  return { package: pkg, tag, digest, reference: `${origin.host}/${pkg}@${digest}`, files };
}

function validateManifest({ raw, expectedDigest, repository, sha, branch, runId, runAttempt, expectedName, minCreatedAt }) {
  if (raw.length > maxManifestBytes) refuse("OCI artifact manifest exceeds its size bound.");
  const digest = `sha256:${sha256Hex(raw)}`;
  if (expectedDigest && digest !== expectedDigest) refuse("OCI artifact manifest digest differs.");
  let manifest;
  try { manifest = JSON.parse(raw.toString("utf8")); } catch { refuse("OCI artifact manifest is malformed JSON."); }
  if (manifest?.schemaVersion !== 2 || manifest.mediaType !== ociManifestMediaType || manifest.artifactType !== ociArtifactType)
    refuse("OCI artifact manifest has an unexpected media or artifact type.");
  if (!Array.isArray(manifest.layers) || manifest.layers.length < 1 || manifest.layers.length > limits.files)
    refuse("OCI artifact manifest holds no bounded layers.");
  const annotations = manifest.annotations ?? {};
  if (annotations["org.nddev.ci.repository"] !== repository ||
      annotations["org.nddev.ci.sha"] !== sha ||
      (branch && annotations["org.nddev.ci.branch"] !== branch) ||
      annotations["org.nddev.ci.run_id"] !== String(runId) ||
      annotations["org.nddev.ci.run_attempt"] !== String(runAttempt))
    refuse("OCI artifact ownership, commit, branch, run or attempt differs from the qualified run.");
  const recordedName = annotations["org.nddev.ci.artifact_name"];
  if (!recordedName || (expectedName && recordedName !== expectedName))
    refuse("OCI artifact name differs from the requested artifact.");
  const createdAt = Date.parse(annotations["org.nddev.ci.created_at"] ?? "");
  if (!Number.isFinite(createdAt) || (minCreatedAt !== null && createdAt < Date.parse(minCreatedAt)))
    refuse(`Artifact ${expectedName ?? recordedName} of the qualified attempt is missing or stale.`);
  return { manifest, digest, name: recordedName, part: annotations["org.nddev.ci.part"] || "" };
}

export async function inspectOciArtifact({
  repository,
  sha,
  branch = "",
  runId,
  runAttempt,
  nameOrDigest,
  minCreatedAt = null,
  token,
  actor = "x-access-token",
  registryUrl = defaultRegistryUrl,
  retryReads = false,
}) {
  if (!shaPattern.test(sha ?? "")) refuse("OCI artifact lookup requires a full 40-character source commit SHA.");
  const origin = registryOriginUrl(registryUrl);
  const pkg = packageName(repository);
  const byDigest = digestPattern.test(nameOrDigest ?? "");
  const reference = byDigest ? nameOrDigest : artifactTag(runId, runAttempt, nameOrDigest);
  const bearer = await registryBearer({ origin, pkg, actions: "pull", token, actor, retryReads });

  const raw = await fetchWithRetry(`${origin.origin}/v2/${pkg}/manifests/${reference}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${bearer}`, Accept: ociManifestMediaType, "User-Agent": "nddev-ci" },
  }, { retryReads, timeout: 60000 }, async (response) => {
    if (response.status === 404) {
      await response.body?.cancel();
      refuse(`Artifact ${nameOrDigest} of run ${runId} attempt ${runAttempt} was not found in GHCR.`);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      refuse(`GHCR refused read access for ${pkg}. Ensure the workflow grants packages: read.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      refuse(`GHCR manifest read failed with HTTP ${response.status}.`);
    }
    const headerDigest = response.headers.get("docker-content-digest");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (headerDigest && headerDigest !== `sha256:${sha256Hex(bytes)}`)
      refuse("GHCR manifest response differs from its reported digest.");
    return bytes;
  });

  const checked = validateManifest({
    raw,
    expectedDigest: byDigest ? nameOrDigest : null,
    repository,
    sha,
    branch,
    runId,
    runAttempt,
    expectedName: byDigest ? null : nameOrDigest,
    minCreatedAt,
  });
  return { ...checked, package: pkg, bearer, origin, reference: `${origin.host}/${pkg}@${checked.digest}` };
}

async function storeBlob(response, layer, destination, retryReads) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    refuse(`OCI blob download failed with HTTP ${response.status}.`);
  }
  const hash = createHash("sha256");
  let size = 0;
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const output = openSync(destination, "wx", 0o600);
  let complete = false;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > layer.size) refuse("OCI blob download exceeds its declared size.");
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) written += writeSync(output, chunk, written, chunk.length - written);
    }
    if (size !== layer.size || `sha256:${hash.digest("hex")}` !== layer.digest)
      refuse("OCI blob bytes differ from their declared size or digest.");
    complete = true;
  } catch (error) {
    if (error instanceof ReleaseError || retryReads) throw error;
    refuse("OCI blob streaming did not complete.");
  } finally {
    closeSync(output);
    if (!complete) rmSync(destination, { force: true });
  }
}

async function downloadBlob({ origin, pkg, bearer, layer, destination, retryReads }) {
  const route = `${origin.origin}/v2/${pkg}/blobs/${layer.digest}`;
  const receive = async (response) => {
    if (![301, 302, 303, 307, 308].includes(response.status))
      return storeBlob(response, layer, destination, retryReads);
    const location = response.headers.get("location");
    await response.body?.cancel();
    const target = redirectUrl(location, origin.origin);
    // Never send registry credentials to a redirected storage host.
    const headers = target.origin === origin.origin ? { Authorization: `Bearer ${bearer}`, "User-Agent": "nddev-ci" } : {};
    return fetchWithRetry(target.href, { method: "GET", headers }, { retryReads, timeout: 900000 },
      (stored) => storeBlob(stored, layer, destination, retryReads));
  };
  await fetchWithRetry(route, {
    method: "GET",
    headers: { Authorization: `Bearer ${bearer}`, "User-Agent": "nddev-ci" },
  }, { retryReads, timeout: 900000 }, receive);
}

export async function pullOciArtifacts({
  repository,
  sha,
  branch = "",
  runId,
  runAttempt,
  minCreatedAt = null,
  names,
  destination,
  topLevelOnly = true,
  token,
  actor = "x-access-token",
  registryUrl = defaultRegistryUrl,
  retryReads = false,
  recheckAfter = null,
}) {
  if (!Array.isArray(names) || !names.length) refuse("At least one OCI artifact must be named.");
  const stage = mkdtempSync(path.join(path.dirname(destination), ".checked-artifacts-"));
  const artifacts = [];
  const files = [];
  const seen = new Set();
  let total = 0;
  try {
    for (const nameOrDigest of names) {
      const inspected = await inspectOciArtifact({
        repository, sha, branch, runId, runAttempt, nameOrDigest, minCreatedAt, token, actor, registryUrl, retryReads,
      });
      artifacts.push({ name: inspected.name, digest: inspected.digest, reference: inspected.reference });
      for (const layer of inspected.manifest.layers) {
        const validSize = topLevelOnly ? positive(layer.size) : (Number.isSafeInteger(layer.size) && layer.size >= 0);
        if (!digestPattern.test(layer?.digest ?? "") || !validSize || layer.size > limits.fileBytes)
          refuse("OCI artifact layer descriptor is malformed or exceeds its size bound.");
        const title = validateTitle(layer.annotations?.["org.opencontainers.image.title"], topLevelOnly);
        const folded = title.toLowerCase();
        if (seen.has(folded) || files.length >= limits.files || (total += layer.size) > limits.totalBytes)
          refuse("Transferred OCI artifact files are repeated or exceed their inventory bound.");
        seen.add(folded);
        const target = path.join(stage, ...title.split("/"));
        await downloadBlob({ origin: inspected.origin, pkg: inspected.package, bearer: inspected.bearer, layer, destination: target, retryReads });
        if (layer.annotations?.["org.nddev.ci.executable"] === "true") chmodSync(target, 0o700);
        files.push({ name: title, size: layer.size, sha256: layer.digest.slice(7), path: path.join(destination, ...title.split("/")) });
      }
    }
    if (recheckAfter) await recheckAfter();
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    renameSync(stage, destination);
    return { artifacts, files };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
