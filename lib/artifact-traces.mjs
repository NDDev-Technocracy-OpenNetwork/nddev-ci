import { createReadStream, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createGunzip, createZstdDecompress } from "node:zlib";

export const DEFAULT_POLICY_PATH = fileURLToPath(new URL("./client-traces-policy.json", import.meta.url));
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_OCI_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_TAR_ENTRIES = 262144;
const OS_CONTENT_SKIP_PREFIXES = [
  "lib/",
  "lib64/",
  "usr/lib/",
  "usr/lib64/",
  "usr/include/",
  "usr/share/doc/",
  "usr/share/locale/",
  "usr/share/man/",
  "usr/share/terminfo/",
  "usr/share/zoneinfo/",
  "var/lib/apt/",
  "var/lib/dpkg/",
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stringList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`Client-trace policy field ${field} must be a non-empty string array.`);
  }
  return value;
}

export function compilePolicy(raw) {
  if (!raw || typeof raw !== "object" || raw.schema_version !== 1) {
    throw new Error("Client-trace policy requires schema_version 1.");
  }
  const forbiddenFilenames = new Set(stringList(raw.forbidden_filenames, "forbidden_filenames").map((item) => item.toLowerCase()));
  const forbiddenFilenamePrefixes = stringList(raw.forbidden_filename_prefixes, "forbidden_filename_prefixes").map((item) => item.toLowerCase());
  const forbiddenDirectories = new Set(stringList(raw.forbidden_directories, "forbidden_directories").map((item) => item.toLowerCase()));
  const forbiddenPathSuffixes = stringList(raw.forbidden_path_suffixes, "forbidden_path_suffixes")
    .map((item) => item.replace(/^\/+|\/+$/g, "").toLowerCase());
  const forbiddenBinaries = new Set(stringList(raw.forbidden_binaries, "forbidden_binaries").map((item) => item.toLowerCase()));

  const signatures = raw.signatures;
  if (!signatures || typeof signatures !== "object") {
    throw new Error("Client-trace policy requires a signatures section.");
  }
  const assistants = [...stringList(signatures.assistants, "signatures.assistants")].sort((a, b) => b.length - a.length);
  const versioned = new Set(stringList(signatures.versioned_assistants, "signatures.versioned_assistants").map((item) => item.toLowerCase()));
  const assistantPattern = "(?:" + assistants.map((name) => {
    const escaped = escapeRegex(name);
    return versioned.has(name.toLowerCase()) ? `${escaped}[\\w .-]*` : escaped;
  }).join("|") + ")";
  const verbs = stringList(signatures.generated_verbs, "signatures.generated_verbs").map(escapeRegex).join("|");
  const prepositions = stringList(signatures.generated_prepositions, "signatures.generated_prepositions").map(escapeRegex).join("|");
  const trailerKeys = stringList(signatures.trailer_keys, "signatures.trailer_keys").map(escapeRegex).join("|");
  const emailPrefixes = stringList(signatures.trailer_email_prefixes, "signatures.trailer_email_prefixes").map(escapeRegex).join("|");
  const botLogins = stringList(signatures.trailer_bot_logins, "signatures.trailer_bot_logins").map(escapeRegex).join("|");
  const emailDomains = stringList(signatures.trailer_email_domains, "signatures.trailer_email_domains").map(escapeRegex).join("|");

  const generated = new RegExp(
    String.raw`^(?:${verbs})\s+(?:${prepositions})\s+(?:\*\*|__)?\[?${assistantPattern}(?:\b|$)`,
    "i",
  );
  const coauthor = new RegExp(
    String.raw`^(?:${trailerKeys}):\s*${assistantPattern}\s*<(?:(?:${emailPrefixes})[^<>@\s]*|[0-9]+\+(?:${botLogins})(?:\[bot\])?)@(?:${emailDomains})>\s*$`,
    "i",
  );

  return {
    raw,
    forbiddenFilenames,
    forbiddenFilenamePrefixes,
    forbiddenDirectories,
    forbiddenPathSuffixes,
    forbiddenBinaries,
    generated,
    coauthor,
  };
}

let cachedDefaultPolicy;
export function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  if (policyPath === DEFAULT_POLICY_PATH && cachedDefaultPolicy) return cachedDefaultPolicy;
  const parsed = JSON.parse(readFileSync(policyPath, "utf8"));
  const compiled = compilePolicy(parsed);
  if (policyPath === DEFAULT_POLICY_PATH) cachedDefaultPolicy = compiled;
  return compiled;
}

export function normalizeEntryPath(entryPath) {
  return String(entryPath ?? "")
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export function matchPath(entryPath, { isDirectory = false, isExecutable = false } = {}, policy = loadPolicy()) {
  const normalized = normalizeEntryPath(entryPath);
  if (!normalized) return null;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const base = segments.at(-1);
  if (base.startsWith(".wh.")) return null;

  const lowerSegments = segments.map((part) => part.toLowerCase());
  const lowerPath = lowerSegments.join("/");
  const lowerBase = lowerSegments.at(-1);

  for (let i = 0; i < lowerSegments.length; i += 1) {
    const isDirSegment = isDirectory || i < lowerSegments.length - 1;
    if (isDirSegment && policy.forbiddenDirectories.has(lowerSegments[i])) {
      return { kind: "forbidden_directory", detail: segments[i] };
    }
  }

  for (const suffix of policy.forbiddenPathSuffixes) {
    if (
      lowerPath === suffix ||
      lowerPath.endsWith("/" + suffix) ||
      lowerPath.startsWith(suffix + "/") ||
      lowerPath.includes("/" + suffix + "/")
    ) {
      return { kind: "forbidden_path", detail: suffix };
    }
  }

  if (!isDirectory) {
    if (policy.forbiddenFilenames.has(lowerBase)) {
      return { kind: "forbidden_filename", detail: base };
    }
    for (const prefix of policy.forbiddenFilenamePrefixes) {
      if (lowerBase.startsWith(prefix)) {
        return { kind: "forbidden_filename_prefix", detail: prefix };
      }
    }
    const parent = lowerSegments.length >= 2 ? lowerSegments.at(-2) : "";
    if ((isExecutable || parent === "bin" || parent === "sbin") && policy.forbiddenBinaries.has(lowerBase)) {
      return { kind: "forbidden_binary", detail: base };
    }
  }
  return null;
}

function stripCommentWrappers(line) {
  let candidate = line.trim();
  if (candidate.startsWith("<!--")) {
    candidate = candidate.slice(4).replace(/-->$/, "").trim();
  } else if (candidate.startsWith("/*")) {
    candidate = candidate.slice(2).replace(/\*\/$/, "").trim();
  } else if (candidate.startsWith("//")) {
    candidate = candidate.slice(2).trim();
  } else if (candidate.startsWith("#")) {
    candidate = candidate.replace(/^#+/, "").trim();
  } else if (candidate.startsWith("* ")) {
    candidate = candidate.slice(2).trim();
  }
  return candidate.replace(/^(?:🤖|✍️)\s*/, "").replace(/^(?:\*\*|__)/, "");
}

export function matchText(text, policy = loadPolicy(), { allowComments = false } = {}) {
  const found = [];
  let fence;
  for (const [index, raw] of (text ?? "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    const marker = line.match(/^([`~])\1{2,}/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1] === fence) fence = undefined;
      continue;
    }
    if (fence || line.startsWith(">") || (!allowComments && /^(?: {4}|\t)/.test(raw))) continue;
    const signature = allowComments
      ? stripCommentWrappers(raw)
      : line.replace(/^(?:🤖|✍️)\s*/, "").replace(/^(?:\*\*|__)/, "");
    if (policy.generated.test(signature) || policy.coauthor.test(signature)) {
      found.push(index + 1);
    }
  }
  return found;
}

function looksBinary(buffer) {
  const bound = Math.min(buffer.length, 8192);
  for (let i = 0; i < bound; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function skipOciContentPath(normalized) {
  const lower = normalized.toLowerCase();
  return OS_CONTENT_SKIP_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function inspectFileContent(buffer, where, findings, policy, { ociImage = false } = {}) {
  if (buffer.length === 0 || buffer.length > MAX_TEXT_BYTES) return;
  if (ociImage && skipOciContentPath(where)) return;
  if (looksBinary(buffer)) return;
  const text = buffer.toString("utf8");
  for (const line of matchText(text, policy, { allowComments: true })) {
    findings.push({ where: `${where}:${line}`, kind: "generated_signature", detail: `line ${line}` });
  }
}

export function inspectDirectory(root, { policy = loadPolicy(), ignoreGit = false } = {}) {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Target path must be a regular directory.");
  }
  const findings = [];
  function walk(current, relativeBase) {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignoreGit && entry.name === ".git") continue;
      const fullPath = path.join(current, entry.name);
      const relPath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
      const stat = lstatSync(fullPath);
      const isDirectory = stat.isDirectory();
      const isExecutable = stat.isFile() && (stat.mode & 0o111) !== 0;
      const hit = matchPath(relPath, { isDirectory, isExecutable }, policy);
      if (hit) {
        findings.push({ where: relPath, ...hit });
        if (isDirectory) continue;
      }
      if (isDirectory) {
        walk(fullPath, relPath);
      } else if (stat.isFile() && stat.size > 0 && stat.size <= MAX_TEXT_BYTES) {
        inspectFileContent(readFileSync(fullPath), relPath, findings, policy);
      }
    }
  }
  walk(root, "");
  return findings;
}

function parseOctal(slice) {
  const raw = slice.toString("ascii").replace(/\0.*$/, "").trim();
  if (!raw) return 0;
  if ((slice[0] & 0x80) !== 0) {
    let value = 0;
    for (let i = 1; i < slice.length; i += 1) value = value * 256 + slice[i];
    return value;
  }
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Malformed numeric tar header field.");
  return parsed;
}

function parsePaxHeaders(data) {
  const headers = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) headers[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return headers;
}

class ChunkReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.chunks = [];
    this.buffered = 0;
    this.offset = 0;
    this.ended = false;
  }

  async fill(needed) {
    while (this.buffered < needed && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      if (next.value.length > 0) {
        this.chunks.push(next.value);
        this.buffered += next.value.length;
      }
    }
  }

  async readExact(count) {
    if (count === 0) return Buffer.alloc(0);
    await this.fill(count);
    if (this.buffered < count) return null;
    const out = Buffer.allocUnsafe(count);
    let copied = 0;
    while (copied < count) {
      const head = this.chunks[0];
      const take = Math.min(head.length, count - copied);
      head.copy(out, copied, 0, take);
      copied += take;
      this.buffered -= take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.offset += count;
    return out;
  }

  async skip(count) {
    let remaining = count;
    while (remaining > 0) {
      if (this.buffered === 0) {
        await this.fill(1);
        if (this.buffered === 0) throw new Error("Unexpected end of tar archive.");
      }
      const head = this.chunks[0];
      const take = Math.min(head.length, remaining);
      remaining -= take;
      this.buffered -= take;
      this.offset += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
  }
}

async function openDecompressedStream(rawStream) {
  const iterator = rawStream[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !first.value || first.value.length === 0) {
    return Readable.from([]);
  }
  const initial = first.value;
  async function* replay() {
    yield initial;
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      yield next.value;
    }
  }
  const source = Readable.from(replay());
  if (initial.length >= 2 && initial[0] === 0x1f && initial[1] === 0x8b) {
    return source.pipe(createGunzip());
  }
  if (initial.length >= 4 && initial[0] === 0x28 && initial[1] === 0xb5 && initial[2] === 0x2f && initial[3] === 0xfd) {
    return source.pipe(createZstdDecompress());
  }
  return source;
}

async function walkTarStream(rawStream, onEntry, { decompress = true } = {}) {
  const tarStream = decompress ? await openDecompressedStream(rawStream) : rawStream;
  const reader = new ChunkReader(tarStream);
  let count = 0;
  let nextLongName = null;
  let nextPax = null;
  for (;;) {
    const header = await reader.readExact(512);
    if (!header) break;
    let zero = true;
    for (let i = 0; i < 512; i += 1) {
      if (header[i] !== 0) {
        zero = false;
        break;
      }
    }
    if (zero) break;
    count += 1;
    if (count > MAX_TAR_ENTRIES) throw new Error("Tar archive exceeds the entry bound.");
    const mode = parseOctal(header.subarray(100, 108));
    let size = parseOctal(header.subarray(124, 136));
    const typeFlag = header[156];
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const rawPrefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    let name = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
    if (nextLongName !== null) {
      name = nextLongName;
      nextLongName = null;
    }
    if (nextPax !== null) {
      if (nextPax.path) name = nextPax.path;
      if (nextPax.size !== undefined) size = Number(nextPax.size);
      nextPax = null;
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("Malformed tar entry size.");
    }
    const contentOffset = reader.offset;
    const pad = (512 - (size % 512)) % 512;

    if (typeFlag === 0x4c) {
      if (size > MAX_OCI_METADATA_BYTES) throw new Error("GNU long name header exceeds bound.");
      const data = await reader.readExact(size);
      if (!data) throw new Error("Truncated GNU long name header.");
      if (pad > 0) await reader.skip(pad);
      nextLongName = data.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (typeFlag === 0x78) {
      if (size > MAX_OCI_METADATA_BYTES) throw new Error("PAX extended header exceeds bound.");
      const data = await reader.readExact(size);
      if (!data) throw new Error("Truncated PAX extended header.");
      if (pad > 0) await reader.skip(pad);
      nextPax = parsePaxHeaders(data);
      continue;
    }
    if (typeFlag === 0x67) {
      if (size + pad > 0) await reader.skip(size + pad);
      continue;
    }

    const isDirectory = typeFlag === 0x35 || name.endsWith("/");
    const isRegular = typeFlag === 0x00 || typeFlag === 0x30;
    const wantContent = onEntry({ name, mode, size, contentOffset, isDirectory, isRegular });
    let content = null;
    if (wantContent && size > 0) {
      content = await reader.readExact(size);
      if (!content) throw new Error("Unexpected end of tar entry data.");
      if (pad > 0) await reader.skip(pad);
      wantContent(content);
    } else if (size + pad > 0) {
      await reader.skip(size + pad);
    }
  }
}

export async function inspectTarStream(rawStream, { policy = loadPolicy(), ociImage = false, labelPrefix = "" } = {}) {
  const findings = [];
  await walkTarStream(rawStream, ({ name, mode, size, isDirectory, isRegular }) => {
    const normalized = normalizeEntryPath(name);
    if (!normalized) return null;
    const isExecutable = isRegular && (mode & 0o111) !== 0;
    const where = labelPrefix ? `${labelPrefix}:${normalized}` : normalized;
    const hit = matchPath(normalized, { isDirectory, isExecutable }, policy);
    if (hit) {
      findings.push({ where, ...hit });
      return null;
    }
    if (!isRegular || size === 0 || size > MAX_TEXT_BYTES) return null;
    if (ociImage && skipOciContentPath(normalized)) return null;
    return (content) => {
      if (!looksBinary(content)) {
        const text = content.toString("utf8");
        for (const line of matchText(text, policy, { allowComments: true })) {
          findings.push({ where: `${where}:${line}`, kind: "generated_signature", detail: `line ${line}` });
        }
      }
    };
  });
  return findings;
}

export async function inspectTarArchive(archivePath, { policy = loadPolicy() } = {}) {
  const stat = lstatSync(archivePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Tar archive path must be a regular file.");
  }
  return inspectTarStream(createReadStream(archivePath), { policy });
}

function readRangeSync(archivePath, entry) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    if (entry.size === 0) return resolve(Buffer.alloc(0));
    const stream = createReadStream(archivePath, { start: entry.offset, end: entry.offset + entry.size - 1 });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export async function inspectOciArchive(archivePath, { policy = loadPolicy() } = {}) {
  const stat = lstatSync(archivePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("OCI archive path must be a regular file.");
  }
  // Outer OCI archives are uncompressed tar; index member byte ranges in one streaming pass.
  const members = new Map();
  const smallJson = new Map();
  await walkTarStream(createReadStream(archivePath), ({ name, size, contentOffset, isRegular }) => {
    if (!isRegular) return null;
    const normalized = normalizeEntryPath(name);
    if (!normalized) return null;
    members.set(normalized, { offset: contentOffset, size });
    if ((normalized === "oci-layout" || normalized === "index.json") && size <= MAX_OCI_METADATA_BYTES) {
      return (content) => smallJson.set(normalized, content);
    }
    return null;
  }, { decompress: false });

  const readJson = async (memberName) => {
    const cached = smallJson.get(memberName);
    if (cached) return JSON.parse(cached.toString("utf8"));
    const entry = members.get(memberName);
    if (!entry || entry.size > MAX_OCI_METADATA_BYTES) {
      throw new Error(`OCI archive is missing valid metadata member ${memberName}.`);
    }
    return JSON.parse((await readRangeSync(archivePath, entry)).toString("utf8"));
  };

  const blobEntry = (digest) => {
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Invalid OCI blob digest: ${digest}`);
    }
    const key = "blobs/sha256/" + digest.slice(7);
    const entry = members.get(key);
    if (!entry) throw new Error(`OCI archive is missing blob ${key}.`);
    return { key, entry };
  };

  const layout = await readJson("oci-layout");
  if (layout.imageLayoutVersion !== "1.0.0") {
    throw new Error("Unsupported OCI archive layout version.");
  }
  const topIndex = await readJson("index.json");
  if (!Array.isArray(topIndex.manifests) || topIndex.manifests.length === 0) {
    throw new Error("OCI archive index has no manifests.");
  }

  const imageManifests = [];
  const queue = [...topIndex.manifests];
  const visited = new Set();
  while (queue.length > 0) {
    const descriptor = queue.shift();
    if (!descriptor?.digest || visited.has(descriptor.digest)) continue;
    visited.add(descriptor.digest);
    if (descriptor.annotations?.["vnd.docker.reference.type"] === "attestation-manifest") continue;
    const { key } = blobEntry(descriptor.digest);
    const doc = await readJson(key);
    if (Array.isArray(doc.manifests)) {
      queue.push(...doc.manifests);
    } else if (Array.isArray(doc.layers) && doc.config?.digest) {
      imageManifests.push(doc);
    }
  }
  if (imageManifests.length === 0) {
    throw new Error("OCI archive contains no image manifests.");
  }

  const findings = [];
  const scannedLayers = new Set();
  for (const manifest of imageManifests) {
    const { key: configKey } = blobEntry(manifest.config.digest);
    const config = await readJson(configKey);
    for (const [labelKey, labelValue] of Object.entries(config.config?.Labels ?? {})) {
      if (typeof labelValue !== "string") continue;
      for (const line of matchText(labelValue, policy, { allowComments: false })) {
        findings.push({
          where: `label:${labelKey}:${line}`,
          kind: "generated_signature",
          detail: `line ${line}`,
        });
      }
    }
    for (const layer of manifest.layers) {
      if (scannedLayers.has(layer.digest)) continue;
      scannedLayers.add(layer.digest);
      const { entry } = blobEntry(layer.digest);
      if (entry.size === 0) continue;
      const stream = createReadStream(archivePath, { start: entry.offset, end: entry.offset + entry.size - 1 });
      const layerHits = await inspectTarStream(stream, {
        policy,
        ociImage: true,
        labelPrefix: `layer:${layer.digest.slice(7, 19)}`,
      });
      findings.push(...layerHits);
    }
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let policyPath = DEFAULT_POLICY_PATH;
    let mode;
    let target;
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--policy" && i + 1 < args.length) {
        policyPath = args[++i];
      } else if ((args[i] === "--directory" || args[i] === "--tar" || args[i] === "--oci-archive") && i + 1 < args.length) {
        if (mode) throw new Error("Pass exactly one target flag (--directory, --tar, or --oci-archive).");
        mode = args[i];
        target = args[++i];
      } else {
        throw new Error(`Unknown argument: ${args[i]}`);
      }
    }
    if (!mode || !target) {
      throw new Error("Usage: artifact-traces.mjs [--policy FILE] (--directory DIR | --tar FILE | --oci-archive FILE)");
    }
    const policy = loadPolicy(policyPath);
    const findings = mode === "--directory"
      ? inspectDirectory(target, { policy })
      : mode === "--tar"
        ? await inspectTarArchive(target, { policy })
        : await inspectOciArchive(target, { policy });
    for (const item of findings) {
      console.error(`${item.where}: ${item.kind} (${item.detail})`);
    }
    if (findings.length > 0) {
      console.error(`Rejected artifact: ${findings.length} AI-coding trace(s) found.`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
