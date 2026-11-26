// Content-addressed OCI artifact transfer on GHCR for private repositories.
// Each artifact is stored as one OCI Image Manifest v1 under <owner>/<repo>/ci-artifacts,
// tagged by run attempt and verified by digest and exact source/run/attempt annotations.
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
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
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createGunzip, createGzip } from "node:zlib";
import { ReleaseError, artifactNames, limits } from "./release.mjs";

export const ociManifestMediaType = "application/vnd.oci.image.manifest.v1+json";
export const ociArtifactType = "application/vnd.nddev.ci.artifact.v1";
export const ociEmptyMediaType = "application/vnd.oci.empty.v1+json";
export const ociArchiveLayerMediaType = "application/vnd.oci.image.layer.v1.tar+gzip";
export const maxBundledFiles = 65536;
export const defaultRegistryUrl = "https://ghcr.io";

const emptyBlob = Buffer.from("{}");
const emptyDigest = `sha256:${createHash("sha256").update(emptyBlob).digest("hex")}`;
// GHCR rejects chunked PATCH requests with Content-Range bodies larger than 4 MiB with HTTP 416.
const monolithicLimitBytes = 4 * 1024 * 1024;
export const defaultChunkBytes = 4 * 1024 * 1024;
const maxManifestBytes = 4 * 1024 * 1024;
const maxPaxHeaderBytes = 64 * 1024;
const maxErrorBodyBytes = 8192;
const ociErrorCodePattern = /^[A-Z0-9_]{1,64}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const dirSegmentPattern = /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,199}$/;
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
const transportCodePattern = /^(?:E[A-Z0-9_]{2,31}|ERR_[A-Z0-9_]{2,48}|UND_ERR_[A-Z0-9_]{2,48})$/;
export const transientHttpStatuses = new Set([500, 502, 503, 504]);

export function isTransientHttpResponse(response) {
  return transientHttpStatuses.has(response.status) &&
    !response.headers.has("retry-after") &&
    response.headers.get("x-ratelimit-remaining") !== "0";
}

export function upstreamReasonForCause(service, cause) {
  if (/^HTTP 5\d\d$/.test(cause ?? "")) return `${service}-5xx`;
  if (cause === "request timeout" || transientTransportCodes.has(cause)) return `${service}-transport`;
  return "";
}

const refuse = (message, options) => {
  throw new ReleaseError(message, options);
};
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

function transportErrorCode(error) {
  const raw = error?.cause?.code ?? error?.cause?.cause?.code ?? error?.cause?.errors?.[0]?.code ?? error?.code;
  return typeof raw === "string" && (
    transientTransportCodes.has(raw) || permanentTransportCodes.has(raw) || transportCodePattern.test(raw)
  ) ? raw : "";
}

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
  const pattern = topLevelOnly ? segmentPattern : dirSegmentPattern;
  for (const part of parts) {
    if (!pattern.test(part)) refuse(`Artifact entry ${JSON.stringify(title)} has an invalid file name.`);
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

export async function collectFiles(pathsText, { cwd, allowedRoots, topLevelOnly = false, maxFiles = topLevelOnly ? limits.files : maxBundledFiles }) {
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
  if (collected.length > maxFiles) refuse("The artifact holds too many files.");

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

function formatPaxRecord(key, value) {
  const payload = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(payload, "utf8") + 1;
  while (true) {
    const record = `${length}${payload}`;
    const bytes = Buffer.byteLength(record, "utf8");
    if (bytes === length) return Buffer.from(record, "utf8");
    length = bytes;
  }
}

function buildTarHeader({ name, mode, size, typeflag }) {
  const header = Buffer.alloc(512, 0);
  const encodedName = Buffer.from(name, "utf8");
  if (encodedName.length <= 100) {
    encodedName.copy(header, 0);
  } else {
    encodedName.subarray(0, 100).copy(header, 0);
  }
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("0000000\0", 329, 8, "ascii");
  header.write("0000000\0", 337, 8, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function writeStreamChunk(stream, chunk) {
  if (stream.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => { stream.off("error", onError); resolve(); };
    const onError = (error) => { stream.off("drain", onDrain); reject(error); };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

// Packs validated sorted files into one deterministic POSIX USTAR/PAX tar+gzip archive.
export async function packDeterministicTarGz(files, destination) {
  const gzip = createGzip({ level: 6 });
  let headerSeen = 0;
  const hash = createHash("sha256");
  let compressedBytes = 0;
  const normalizeAndHash = new Transform({
    transform(chunk, _encoding, callback) {
      const out = Buffer.from(chunk);
      if (headerSeen < 10) {
        const osByteOffset = 9 - headerSeen;
        if (osByteOffset >= 0 && osByteOffset < out.length) out[osByteOffset] = 0x03;
        headerSeen += out.length;
      }
      compressedBytes += out.length;
      hash.update(out);
      callback(null, out);
    },
  });
  const fileOut = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  const finished = pipeline(gzip, normalizeAndHash, fileOut);

  try {
    const sorted = [...files].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    const zeroBlock = Buffer.alloc(512, 0);
    for (let index = 0; index < sorted.length; index++) {
      const file = sorted[index];
      const titleBytes = Buffer.byteLength(file.title, "utf8");
      const needsPax = titleBytes > 100 || /[^\x20-\x7e]/.test(file.title) || file.size > 0o77777777777;
      if (needsPax) {
        const records = [formatPaxRecord("path", file.title)];
        if (file.size > 0o77777777777) records.push(formatPaxRecord("size", String(file.size)));
        const paxBody = Buffer.concat(records);
        const paxHeader = buildTarHeader({
          name: `pax/${index}`,
          mode: 0o644,
          size: paxBody.length,
          typeflag: "x",
        });
        await writeStreamChunk(gzip, paxHeader);
        await writeStreamChunk(gzip, paxBody);
        const paxRem = paxBody.length % 512;
        if (paxRem) await writeStreamChunk(gzip, zeroBlock.subarray(0, 512 - paxRem));
      }
      const header = buildTarHeader({
        name: needsPax ? `entry/${index}` : file.title,
        mode: file.executable ? 0o755 : 0o644,
        size: file.size,
        typeflag: "0",
      });
      await writeStreamChunk(gzip, header);
      let written = 0;
      for await (const chunk of createReadStream(file.path)) {
        written += chunk.length;
        if (written > file.size) refuse("Artifact file grew during archive packing.");
        await writeStreamChunk(gzip, chunk);
      }
      if (written !== file.size) refuse("Artifact file changed size during archive packing.");
      const rem = file.size % 512;
      if (rem) await writeStreamChunk(gzip, zeroBlock.subarray(0, 512 - rem));
    }
    await writeStreamChunk(gzip, zeroBlock);
    await writeStreamChunk(gzip, zeroBlock);
    gzip.end();
    await finished;
  } catch (error) {
    gzip.destroy();
    await finished.catch(() => {});
    rmSync(destination, { force: true });
    throw error;
  }

  const stat = statSync(destination);
  if (stat.size !== compressedBytes || compressedBytes < 1 || compressedBytes > limits.fileBytes)
    refuse("Packed OCI artifact archive exceeds its size bound.");
  const sha256 = hash.digest("hex");
  return { path: destination, size: compressedBytes, sha256, digest: `sha256:${sha256}` };
}

function parseOctalField(buffer, start, length) {
  const raw = buffer.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) refuse("OCI artifact tar header contains a malformed numeric field.");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) refuse("OCI artifact tar numeric field exceeds safe bounds.");
  return value;
}

function verifyTarChecksum(header) {
  const expected = parseOctalField(header, 148, 8);
  let actual = 0;
  for (let i = 0; i < 512; i++) actual += (i >= 148 && i < 156) ? 0x20 : header[i];
  if (actual !== expected) refuse("OCI artifact tar header checksum is invalid.");
}

function parsePaxRecords(buffer) {
  const fields = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space <= offset) refuse("OCI artifact PAX extended header is malformed.");
    const lengthText = buffer.subarray(offset, space).toString("ascii");
    if (!/^[1-9]\d{0,6}$/.test(lengthText)) refuse("OCI artifact PAX record length is invalid.");
    const recordLength = Number(lengthText);
    const end = offset + recordLength;
    if (end > buffer.length || buffer[end - 1] !== 0x0a) refuse("OCI artifact PAX record is truncated.");
    const entry = buffer.subarray(space + 1, end - 1).toString("utf8");
    const eq = entry.indexOf("=");
    if (eq <= 0) refuse("OCI artifact PAX record is missing a key.");
    fields[entry.slice(0, eq)] = entry.slice(eq + 1);
    offset = end;
  }
  return fields;
}

function isAllZeroBlock(block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

export async function unpackSafeTarGz(archivePath, stageDir, destinationDir, state) {
  const gunzip = createGunzip();
  const source = createReadStream(archivePath);
  const extracted = [];
  let pending = Buffer.alloc(0);
  let mode = "header";
  let pax = null;
  let paxRemaining = 0;
  let paxChunks = [];
  let padRemaining = 0;
  let fileFd = null;
  let fileTarget = "";
  let fileTitle = "";
  let fileSize = 0;
  let fileRemaining = 0;
  let fileExecutable = false;
  let fileHash = null;
  let zeroBlocks = 0;

  const closeCurrentFile = (complete) => {
    if (fileFd !== null) {
      closeSync(fileFd);
      fileFd = null;
      if (!complete && fileTarget) rmSync(fileTarget, { force: true });
    }
  };

  try {
    source.on("error", (error) => gunzip.destroy(error));
    source.pipe(gunzip);
    for await (const rawChunk of gunzip) {
      pending = pending.length ? Buffer.concat([pending, rawChunk]) : rawChunk;
      while (pending.length > 0) {
        if (mode === "header") {
          if (pending.length < 512) break;
          const header = pending.subarray(0, 512);
          pending = pending.subarray(512);
          if (isAllZeroBlock(header)) {
            zeroBlocks++;
            if (zeroBlocks >= 2) mode = "eof";
            continue;
          }
          if (zeroBlocks > 0) refuse("OCI artifact tar archive has unexpected data after an end block.");
          verifyTarChecksum(header);
          const typeflag = String.fromCharCode(header[156]);
          const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
          const rawPrefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
          const headerSize = parseOctalField(header, 124, 12);
          const headerMode = parseOctalField(header, 100, 8);

          if (typeflag === "x") {
            if (pax !== null) refuse("OCI artifact tar archive has consecutive PAX headers.");
            if (headerSize < 1 || headerSize > maxPaxHeaderBytes)
              refuse("OCI artifact PAX header exceeds its size bound.");
            paxRemaining = headerSize;
            paxChunks = [];
            padRemaining = (512 - (headerSize % 512)) % 512;
            mode = "pax";
            continue;
          }

          const combinedName = pax?.path ?? (rawPrefix ? `${rawPrefix}/${rawName}` : rawName);
          if (pax?.size !== undefined && !/^(0|[1-9]\d{0,15})$/.test(pax.size))
            refuse("OCI artifact PAX size record is malformed.");
          const actualSize = pax?.size !== undefined ? Number(pax.size) : headerSize;
          pax = null;
          if (!Number.isSafeInteger(actualSize) || actualSize < 0 || actualSize > limits.fileBytes)
            refuse("OCI artifact archive entry exceeds its size bound.");

          if (typeflag === "5") {
            if (actualSize !== 0) refuse("OCI artifact directory entry cannot carry bytes.");
            const normalizedDir = combinedName.replace(/\/+$/, "");
            if (normalizedDir && normalizedDir !== ".") validateTitle(normalizedDir, false);
            continue;
          }
          if (typeflag !== "0" && typeflag !== "\0")
            refuse("OCI artifact archive can contain only regular files.");

          const title = validateTitle(combinedName, false);
          const folded = title.toLowerCase();
          if (state.seen.has(folded) || state.files.length >= maxBundledFiles || (state.total + actualSize) > limits.totalBytes)
            refuse("Transferred OCI artifact archive entries are repeated or exceed their inventory bound.");
          state.seen.add(folded);
          state.total += actualSize;

          const target = path.join(stageDir, ...title.split("/"));
          mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          assertNoSymlinkPrefix(stageDir, path.dirname(target));
          fileFd = openSync(target, "wx", 0o600);
          fileTarget = target;
          fileTitle = title;
          fileSize = actualSize;
          fileRemaining = actualSize;
          fileExecutable = (headerMode & 0o111) !== 0;
          fileHash = createHash("sha256");
          padRemaining = (512 - (actualSize % 512)) % 512;

          if (fileRemaining === 0) {
            closeCurrentFile(true);
            if (fileExecutable) chmodSync(fileTarget, 0o700);
            const entry = {
              name: fileTitle,
              size: 0,
              sha256: fileHash.digest("hex"),
              path: path.join(destinationDir, ...fileTitle.split("/")),
            };
            state.files.push(entry);
            extracted.push(entry);
            mode = padRemaining ? "pad" : "header";
          } else {
            mode = "file";
          }
        } else if (mode === "pax") {
          const take = Math.min(paxRemaining, pending.length);
          paxChunks.push(pending.subarray(0, take));
          pending = pending.subarray(take);
          paxRemaining -= take;
          if (paxRemaining === 0) {
            pax = parsePaxRecords(Buffer.concat(paxChunks));
            paxChunks = [];
            mode = padRemaining ? "pad" : "header";
          }
        } else if (mode === "file") {
          const take = Math.min(fileRemaining, pending.length);
          const slice = pending.subarray(0, take);
          pending = pending.subarray(take);
          fileHash.update(slice);
          let written = 0;
          while (written < slice.length) written += writeSync(fileFd, slice, written, slice.length - written);
          fileRemaining -= take;
          if (fileRemaining === 0) {
            closeCurrentFile(true);
            if (fileExecutable) chmodSync(fileTarget, 0o700);
            const entry = {
              name: fileTitle,
              size: fileSize,
              sha256: fileHash.digest("hex"),
              path: path.join(destinationDir, ...fileTitle.split("/")),
            };
            state.files.push(entry);
            extracted.push(entry);
            mode = padRemaining ? "pad" : "header";
          }
        } else if (mode === "pad") {
          const take = Math.min(padRemaining, pending.length);
          pending = pending.subarray(take);
          padRemaining -= take;
          if (padRemaining === 0) mode = "header";
        } else if (mode === "eof") {
          for (let i = 0; i < pending.length; i++) {
            if (pending[i] !== 0) refuse("OCI artifact tar archive has trailing bytes after EOF.");
          }
          pending = Buffer.alloc(0);
        }
      }
    }
    if (mode !== "header" && mode !== "eof")
      refuse("OCI artifact tar archive ended mid-entry.");
    if (pending.length !== 0 || pax !== null)
      refuse("OCI artifact tar archive is truncated.");
    if (!extracted.length)
      refuse("OCI artifact tar archive contained no regular files.");
    return extracted;
  } catch (error) {
    closeCurrentFile(false);
    source.destroy();
    gunzip.destroy();
    if (error instanceof ReleaseError) throw error;
    refuse("OCI artifact tar+gzip archive could not be unpacked cleanly.");
  }
}

export async function validateOciArtifact({
  name,
  pathsText,
  cwd,
  allowedRoots,
  topLevelOnly = false,
}) {
  const [checked] = artifactNames(name);
  if (!checked) refuse("OCI artifact validation requires a plain artifact name.");
  const files = await collectFiles(pathsText, { cwd, allowedRoots, topLevelOnly });
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  return { name: checked, files, bundled: files.length > limits.files, totalBytes };
}

export async function retryableFetch(request, {
  retry = false,
  timeout = 60000,
  consume,
  shouldRetryResponse = isTransientHttpResponse,
  onUnretriedError = (cause) => refuse(
    cause ? `The OCI registry transport did not complete (${cause}).` : "The OCI registry transport did not complete.",
    { upstreamReason: upstreamReasonForCause("ghcr", cause) },
  ),
  onExhausted = (attempt, cause) => refuse(
    `The OCI registry read failed after ${attempt} attempt${attempt === 1 ? "" : "s"} (${cause}).`,
    { upstreamReason: upstreamReasonForCause("ghcr", cause) },
  ),
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
      const code = transportErrorCode(error);
      transient = signal.aborted || transientTransportCodes.has(code);
      cause = signal.aborted ? "request timeout" : code || "unclassified transport error";
      if (!retry) onUnretriedError(cause);
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
      refuse(
        `GHCR token exchange failed with HTTP ${response.status}.`,
        response.status >= 500 && response.status < 600 ? { upstreamReason: "ghcr-5xx" } : undefined,
      );
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
  refuse(
    `GHCR ${action} failed with HTTP ${response.status}${detail}.`,
    response.status >= 500 && response.status < 600 ? { upstreamReason: "ghcr-5xx" } : undefined,
  );
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
  const bundled = !topLevelOnly && files.length > limits.files;
  let layers;
  let archiveTitle = "";
  let archiveDigest = "";
  let archiveSize = 0;
  let bundleScratch = "";

  try {
    if (bundled) {
      const scratchBase = process.env.RUNNER_TEMP && existsSync(process.env.RUNNER_TEMP) ? process.env.RUNNER_TEMP : tmpdir();
      bundleScratch = mkdtempSync(path.join(scratchBase, "nddev-oci-bundle-"));
      archiveTitle = `${name}.tar.gz`;
      const bundle = await packDeterministicTarGz(files, path.join(bundleScratch, archiveTitle));
      archiveDigest = bundle.digest;
      archiveSize = bundle.size;
      if (!uploaded.has(bundle.digest)) {
        await uploadBlob({ origin, pkg, bearer, digest: bundle.digest, size: bundle.size, source: bundle.path, chunkBytes });
        uploaded.add(bundle.digest);
      }
      layers = [{
        mediaType: ociArchiveLayerMediaType,
        digest: bundle.digest,
        size: bundle.size,
        annotations: {
          "org.opencontainers.image.title": archiveTitle,
          "org.nddev.ci.archive": "tar+gzip",
          "org.nddev.ci.file_count": String(files.length),
        },
      }];
    } else {
      for (const file of files) {
        if (uploaded.has(file.digest)) continue;
        await uploadBlob({ origin, pkg, bearer, digest: file.digest, size: file.size, source: file.path, chunkBytes });
        uploaded.add(file.digest);
      }
      layers = files.map((file) => ({
        mediaType: "application/octet-stream",
        digest: file.digest,
        size: file.size,
        annotations: {
          "org.opencontainers.image.title": file.title,
          ...(file.executable ? { "org.nddev.ci.executable": "true" } : {}),
        },
      }));
    }

    const writerId = randomUUID();
    const manifest = {
      schemaVersion: 2,
      mediaType: ociManifestMediaType,
      artifactType: ociArtifactType,
      config: { mediaType: ociEmptyMediaType, digest: emptyDigest, size: emptyBlob.length },
      layers,
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
        ...(bundled ? { "org.nddev.ci.archive": "tar+gzip", "org.nddev.ci.file_count": String(files.length) } : {}),
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
    if (verify.status >= 500 && verify.status < 600) {
      await verify.body?.cancel();
      refuse(`GHCR manifest verification failed with HTTP ${verify.status}.`, { upstreamReason: "ghcr-5xx" });
    }
    const verifiedBytes = Buffer.from(await verify.arrayBuffer());
    if (!verify.ok || `sha256:${sha256Hex(verifiedBytes)}` !== digest)
      refuse(`Artifact ${name} changed concurrently during upload.`);
    const parsed = JSON.parse(verifiedBytes.toString("utf8"));
    if (parsed?.annotations?.["org.nddev.ci.writer_id"] !== writerId)
      refuse(`Artifact ${name} was overwritten by another job of this attempt.`);

    return {
      package: pkg,
      tag,
      digest,
      reference: `${origin.host}/${pkg}@${digest}`,
      files,
      bundled,
      ...(bundled ? { archiveTitle, archiveDigest, archiveSize } : {}),
    };
  } finally {
    if (bundleScratch) rmSync(bundleScratch, { recursive: true, force: true });
  }
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
      refuse(
        `GHCR manifest read failed with HTTP ${response.status}.`,
        response.status >= 500 && response.status < 600 ? { upstreamReason: "ghcr-5xx" } : undefined,
      );
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
    refuse(
      `OCI blob download failed with HTTP ${response.status}.`,
      response.status >= 500 && response.status < 600 ? { upstreamReason: "ghcr-5xx" } : undefined,
    );
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
    const cause = transportErrorCode(error) || "unclassified transport error";
    refuse(
      `OCI blob streaming did not complete (${cause}).`,
      { upstreamReason: upstreamReasonForCause("ghcr", cause) },
    );
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
  const archiveScratch = mkdtempSync(path.join(path.dirname(destination), ".checked-archives-"));
  const artifacts = [];
  const state = { files: [], seen: new Set(), total: 0 };
  let archiveIndex = 0;
  try {
    for (const nameOrDigest of names) {
      const inspected = await inspectOciArtifact({
        repository, sha, branch, runId, runAttempt, nameOrDigest, minCreatedAt, token, actor, registryUrl, retryReads,
      });
      artifacts.push({ name: inspected.name, digest: inspected.digest, reference: inspected.reference });
      for (const layer of inspected.manifest.layers) {
        const isTarGzArchive = layer.annotations?.["org.nddev.ci.archive"] === "tar+gzip";
        const validSize = (topLevelOnly || isTarGzArchive)
          ? positive(layer.size)
          : (Number.isSafeInteger(layer.size) && layer.size >= 0);
        if (!digestPattern.test(layer?.digest ?? "") || !validSize || layer.size > limits.fileBytes)
          refuse("OCI artifact layer descriptor is malformed or exceeds its size bound.");
        if (isTarGzArchive && !topLevelOnly) {
          validateTitle(layer.annotations?.["org.opencontainers.image.title"], true);
          const archivePath = path.join(archiveScratch, `bundle-${archiveIndex++}.tar.gz`);
          await downloadBlob({ origin: inspected.origin, pkg: inspected.package, bearer: inspected.bearer, layer, destination: archivePath, retryReads });
          await unpackSafeTarGz(archivePath, stage, destination, state);
          rmSync(archivePath, { force: true });
          continue;
        }
        const title = validateTitle(layer.annotations?.["org.opencontainers.image.title"], topLevelOnly);
        const folded = title.toLowerCase();
        const maxPullFiles = topLevelOnly ? limits.files : maxBundledFiles;
        if (state.seen.has(folded) || state.files.length >= maxPullFiles || (state.total += layer.size) > limits.totalBytes)
          refuse("Transferred OCI artifact files are repeated or exceed their inventory bound.");
        state.seen.add(folded);
        const target = path.join(stage, ...title.split("/"));
        await downloadBlob({ origin: inspected.origin, pkg: inspected.package, bearer: inspected.bearer, layer, destination: target, retryReads });
        if (layer.annotations?.["org.nddev.ci.executable"] === "true") chmodSync(target, 0o700);
        state.files.push({ name: title, size: layer.size, sha256: layer.digest.slice(7), path: path.join(destination, ...title.split("/")) });
      }
    }
    if (recheckAfter) await recheckAfter();
    state.files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    renameSync(stage, destination);
    return { artifacts, files: state.files };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(archiveScratch, { recursive: true, force: true });
  }
}
