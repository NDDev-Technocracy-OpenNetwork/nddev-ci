// One product version from the source-bound metadata of the checked artifacts. Tag-only source
// releases retain their own version selection; a product manifest never gets another number.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { ReleaseError, artifactNames, nextVersion, parseVersion } from "./release.mjs";

const refuse = (message) => { throw new ReleaseError(message); };
const fullSha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

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

export async function releaseVersion(github, {repository, sha, files = [], metadata = "", explicit = "", initial = "0.1.0"}) {
  const declared = productVersion(files, metadata, sha);
  const refs = await github.json("GET", `/repos/${repository}/git/matching-refs/tags/v`);
  if (!Array.isArray(refs) || refs.length > 1000) refuse("The release tag inventory is malformed or exceeds its bound.");
  const tags = [], seen = new Set();
  let existing;
  for (const item of refs) {
    if (typeof item?.ref !== "string" || !item.ref.startsWith("refs/tags/v"))
      refuse("The release tag inventory contains an unexpected reference identity.");
    const tag = item.ref.slice(10);
    if (!parseVersion(tag.slice(1)) || !tag.startsWith("v")) continue;
    if (seen.has(tag)) refuse("The release tag inventory repeats a version.");
    seen.add(tag); tags.push(tag);
    const target = await tagCommit(github, repository, item.object);
    if (target === sha) {
      if (existing) refuse(`Commit ${sha} already carries two release versions.`);
      existing = tag.slice(1);
    }
  }
  if (declared) {
    if ((explicit && explicit !== declared) || (existing && existing !== declared))
      refuse("The checked product version differs from the requested or existing release version.");
    if (!existing) nextVersion({tags, explicit: declared, initial});
    return declared;
  }
  return existing ?? nextVersion({tags, explicit, initial});
}
