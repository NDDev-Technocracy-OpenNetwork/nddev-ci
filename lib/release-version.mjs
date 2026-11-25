// One product version from the source-bound metadata of the checked artifacts. Tag-only source
// releases retain their own version selection; a product manifest never gets another number.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import {
  ReleaseError,
  UnversionedError,
  artifactNames,
  isPrerelease,
  newestRelease,
  nextVersion,
  parsePrereleaseStage,
  parseReleaseVersion,
  parseVersion,
  previousReleaseTag,
} from "./release.mjs";

const refuse = (message) => { throw new ReleaseError(message); };
const fullSha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const relativeFilePath = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export function productVersion(files, selected, sha) {
  const names = artifactNames(selected);
  if (!names.length) return null;
  if (!fullSha(sha)) refuse("Product metadata needs the full checked source commit.");
  let version;
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name.toLowerCase())) refuse("Product metadata repeats a file name.");
    seen.add(name.toLowerCase());
    const matches = files.filter((file) => file.name === name);
    if (matches.length !== 1) refuse(`Checked product metadata ${name} is missing or repeated.`);
    const file = matches[0];
    let metadata;
    try {
      const stat = lstatSync(file.path);
      if (!stat.isFile() || stat.size !== file.size || stat.size > 65536)
        refuse("Product metadata must be a bounded regular checked file.");
      const bytes = readFileSync(file.path);
      if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
        refuse("Product metadata changed after artifact verification.");
      metadata = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    } catch (error) {
      if (error instanceof ReleaseError) throw error;
      refuse(`Checked product metadata ${name} is unreadable or malformed.`);
    }
    if (!metadata || Array.isArray(metadata) || metadata.schema_version !== 1 ||
        metadata.source_commit !== sha || typeof metadata.version !== "string" || !parseVersion(metadata.version))
      refuse(`Product metadata ${name} differs from the checked source or version contract.`);
    if (version && version !== metadata.version)
      refuse("The checked product platforms disagree on their release version.");
    version = metadata.version;
  }
  return version;
}

export async function readPrereleaseStage(github, {repository, sha, file = ""}) {
  const target = (file ?? "").trim();
  if (!target) return "";
  if (!repositoryName.test(repository ?? "") || !fullSha(sha))
    refuse("Pre-release declaration lookup requires an exact repository and commit.");
  if (target.length > 255 || !relativeFilePath.test(target) ||
      target.split("/").some((segment) => segment === "." || segment === ".."))
    refuse("Pre-release file must be a plain repository-relative path.");
  const encodedPath = target.split("/").map(encodeURIComponent).join("/");
  const item = await github.json("GET", `/repos/${repository}/contents/${encodedPath}?ref=${sha}`, {optional: true});
  if (item === null) return "";
  if (!item || Array.isArray(item) || item.type !== "file" || item.path !== target ||
      !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 256)
    refuse(`Pre-release file ${target} must be a bounded regular file.`);
  if (item.size === 0 && (item.content ?? "") === "" && (item.encoding === "base64" || item.encoding === "none"))
    return "";
  if (item.encoding !== "base64" || typeof item.content !== "string" || !/^[A-Za-z0-9+/=\r\n]*$/.test(item.content))
    refuse(`Pre-release file ${target} has unreadable content encoding.`);
  const bytes = Buffer.from(item.content, "base64");
  if (bytes.length !== item.size) refuse(`Pre-release file ${target} content length differs from its metadata.`);
  let text;
  try {
    text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  } catch {
    refuse(`Pre-release file ${target} is not valid UTF-8.`);
  }
  const value = text.trim();
  if (!value) return "";
  if (!parsePrereleaseStage(value))
    refuse(`Pre-release file ${target} must declare one stage as X.Y.Z-alpha, -beta or -rc.`);
  return value;
}

export async function tagCommit(github, repository, value) {
  let object = value;
  const visited = new Set();
  for (let depth = 0; object?.type === "tag" && depth < 4; depth++) {
    if (!fullSha(object.sha) || visited.has(object.sha)) refuse("A release tag has an invalid or cyclic target.");
    visited.add(object.sha);
    object = (await github.json("GET", `/repos/${repository}/git/tags/${object.sha}`))?.object;
  }
  if (object?.type !== "commit" || !fullSha(object.sha)) refuse("A release tag has no bounded commit target.");
  return object.sha;
}

export async function resolveRelease(github, {
  repository, sha, files = [], metadata = "", explicit = "", initial = "0.1.0", prereleaseFile = "",
}) {
  const declared = productVersion(files, metadata, sha);
  const prerelease = await readPrereleaseStage(github, {repository, sha, file: prereleaseFile});
  const refs = await github.json("GET", `/repos/${repository}/git/matching-refs/tags/v`);
  if (!Array.isArray(refs) || refs.length > 1000) refuse("The release tag inventory is malformed or exceeds its bound.");
  const tags = [], seen = new Set();
  let existing;
  for (const item of refs) {
    if (typeof item?.ref !== "string" || !item.ref.startsWith("refs/tags/v"))
      refuse("The release tag inventory contains an unexpected reference identity.");
    const tag = item.ref.slice(10);
    if (!tag.startsWith("v") || !parseReleaseVersion(tag.slice(1))) continue;
    if (seen.has(tag)) refuse("The release tag inventory repeats a version.");
    seen.add(tag); tags.push(tag);
    const target = await tagCommit(github, repository, item.object);
    if (target === sha) {
      if (existing) refuse(`Commit ${sha} already carries two release versions.`);
      existing = tag.slice(1);
    }
  }
  if (prerelease) {
    const stage = parsePrereleaseStage(prerelease);
    if (explicit) refuse("An explicit version cannot be used while a pre-release stage is declared.");
    if (declared && declared !== stage.base)
      refuse("The checked product version differs from the declared pre-release stage.");
    if (existing) {
      const existingParsed = parseReleaseVersion(existing);
      if (existingParsed.base !== stage.base || existingParsed.stage !== stage.stage)
        refuse("The existing release version differs from the declared pre-release stage.");
      return {version: existing, prerelease: true, previousTag: previousReleaseTag(tags, existing)};
    }
    const version = nextVersion({tags, initial, prerelease});
    return {version, prerelease: true, previousTag: previousReleaseTag(tags, version)};
  }
  if (declared) {
    if ((explicit && explicit !== declared) || (existing && existing !== declared))
      refuse("The checked product version differs from the requested or existing release version.");
    if (!existing && newestRelease(tags)?.text === declared)
      throw new UnversionedError(`Version ${declared} is already released; the source version update releases this commit.`);
    if (!existing) nextVersion({tags, explicit: declared, initial});
    return {version: declared, prerelease: false, previousTag: previousReleaseTag(tags, declared)};
  }
  if (existing) {
    if (explicit && explicit !== existing)
      refuse("The requested release version differs from the existing release version.");
    if ((prereleaseFile ?? "").trim() && isPrerelease(existing))
      refuse("The existing pre-release tag differs from the cleared pre-release stage.");
    return {version: existing, prerelease: isPrerelease(existing), previousTag: previousReleaseTag(tags, existing)};
  }
  const version = nextVersion({tags, explicit, initial});
  return {version, prerelease: false, previousTag: previousReleaseTag(tags, version)};
}

export async function releaseVersion(github, options) {
  return (await resolveRelease(github, options)).version;
}
