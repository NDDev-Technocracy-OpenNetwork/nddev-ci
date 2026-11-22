import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { UnversionedError } from "../lib/release.mjs";
import { productVersion, releaseVersion } from "../lib/release-version.mjs";

const sha = "a".repeat(40), other = "b".repeat(40);
const record = (version = "1.2.3") => ({schema_version: 1, source_commit: sha, version, platform: "example"});
function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "release-version-"));
  const file = (name, data) => {
    const bytes = Buffer.from(typeof data === "string" ? data : JSON.stringify(data));
    const target = path.join(root, name); writeFileSync(target, bytes);
    return {name, path: target, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
  };
  return Promise.resolve().then(() => run(file)).finally(() => rmSync(root, {recursive: true, force: true}));
}
const tag = (version, target = other) => ({ref: `refs/tags/v${version}`, object: {type: "commit", sha: target}});
const api = (tags) => ({json: async (method) => { assert.equal(method, "GET"); return tags; }});

test("checked platform metadata supplies one exact product version", () => fixture((file) => {
  const files = [file("linux.json", record()), file("mac.json", record())];
  assert.equal(productVersion(files, "linux.json\nmac.json", sha), "1.2.3");
  assert.equal(productVersion([], "", sha), null);
  assert.throws(() => productVersion(files, "linux.json\nLINUX.json", sha), /repeats/);
  assert.throws(() => productVersion(files, "missing.json", sha), /missing/);
  assert.throws(() => productVersion([...files, files[0]], "linux.json", sha), /repeated/);
  assert.throws(() => productVersion(files, "../linux.json", sha));
}));

test("wrong source, malformed versions, missing fields and changed checked bytes fail", () => fixture((file) => {
  for (const data of [null, [], {}, {...record(), schema_version: 2}, {...record(), source_commit: other},
    {...record(), version: "v1.2.3"}, {...record(), version: "01.2.3"}, {...record(), version: ["1.2.3"]},
    "{", " ".repeat(65537)]) {
    const f = file("metadata.json", data);
    assert.throws(() => productVersion([f], f.name, sha));
  }
  const f = file("metadata.json", record());
  writeFileSync(f.path, JSON.stringify({...record(), version: "1.2.4"}));
  assert.throws(() => productVersion([f], f.name, sha), /changed/);
  const invalid = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
  writeFileSync(f.path, invalid);
  const encoded = {...f, size: invalid.length, sha256: createHash("sha256").update(invalid).digest("hex")};
  assert.throws(() => productVersion([encoded], encoded.name, sha), /malformed/);
}));

test("platform disagreement cannot select a product version", () => fixture((file) => {
  const files = [file("linux.json", record()), file("mac.json", record("1.2.4"))];
  assert.throws(() => productVersion(files, "linux.json\nmac.json", sha), /disagree/);
}));

test("a product release uses its checked version and reconciles that same commit", () => fixture(async (file) => {
  const fields = {repository: "owner/project", sha, files: [file("metadata.json", record("1.5.0"))], metadata: "metadata.json"};
  assert.equal(await releaseVersion(api([tag("1.2.3")]), fields), "1.5.0");
  assert.equal(await releaseVersion(api([tag("1.2.3"), tag("1.5.0", sha)]), fields), "1.5.0");
  await assert.rejects(releaseVersion(api([tag("1.2.3"), tag("1.5.0")]), fields), UnversionedError);
  for (const tags of [[tag("1.6.0")], [tag("1.5.0"), tag("1.6.0")], [tag("1.4.0", sha)], [tag("1.5.0", sha), tag("1.5.1", sha)]])
    await assert.rejects(releaseVersion(api(tags), fields), (error) => !(error instanceof UnversionedError));
  await assert.rejects(releaseVersion(api([]), {...fields, explicit: "1.6.0"}), /differs/);
}));

test("annotated targets are bounded and tag-only source releases retain their selection", async () => {
  const fields = {repository: "owner/project", sha};
  assert.equal(await releaseVersion(api([tag("1.2.3")]), fields), "1.2.4");
  assert.equal(await releaseVersion(api([tag("1.2.3", sha)]), fields), "1.2.3");
  const annotated = {json: async (_method, route) => route.includes("matching-refs")
    ? [{ref: "refs/tags/v1.2.3", object: {type: "tag", sha: other}}]
    : {object: {type: "commit", sha}}};
  assert.equal(await releaseVersion(annotated, fields), "1.2.3");
  annotated.json = async (_method, route) => route.includes("matching-refs")
    ? [{ref: "refs/tags/v1.2.3", object: {type: "tag", sha: other}}]
    : {object: {type: "tag", sha: other}};
  await assert.rejects(releaseVersion(annotated, fields), /cyclic/);
  await assert.rejects(releaseVersion(api([tag("1.2.3"), tag("1.2.3")]), fields), /repeats/);
  for (const refs of [null, {}, [{ref: "refs/tags/foreign", object: {type: "commit", sha}}]])
    await assert.rejects(releaseVersion(api(refs), fields));
});
