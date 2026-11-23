import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { archiveSelector, downloadArchive, reportResult } from "../actions/registry-project/run.mjs";

const bytes = Buffer.from("compressed archive bytes");
const hash = createHash("sha256").update(bytes).digest("hex");
const selector = {repository_id: 101, release_id: 202, asset_id: 303, sha256: hash};
const asset = archiveSelector({registry_cli_asset: selector});

test("the protected asset selector requires exact numeric identities and digest", () => {
  assert.equal(asset.path, "/github-releases/sha256/" + hash + "/private/101/202/303");
  for (const invalid of [{asset_id: "303"}, {release_id: 0}, {repository_id: 1.5}, {sha256: "x"}])
    assert.throws(() => archiveSelector({registry_cli_asset: {...selector, ...invalid}}), /valid CLI archive selector/);
  assert.throws(() => archiveSelector({}), /valid CLI archive selector/);
});

test("the managed gateway's bytes must match the protected digest", async () => {
  let responseBytes = bytes;
  const requests = [];
  const authorization = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    authorization.push(request.headers.authorization);
    response.end(responseBytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const gateway = "http://127.0.0.1:" + server.address().port;
    assert.deepEqual(await downloadArchive(gateway, asset), bytes);
    responseBytes = Buffer.from("unverified archive bytes");
    await assert.rejects(downloadArchive(gateway, asset), /protected SHA-256/);
    assert.deepEqual(requests, [asset.path, asset.path]);
    assert.deepEqual(authorization, [undefined, undefined]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("only a new finding blocks a pull request", () => {
  const base = "a".repeat(40);
  const existing = {name: "existing-fixture", version: "1"};
  const added = {name: "new-fixture", version: "2"};
  const complete = {read_complete: true, missing: [existing], outside_lines: [], new: [], base};
  assert.equal(reportResult(JSON.stringify(complete), 0, base, true), 0);
  const report = JSON.stringify({...complete, new: [added]});
  assert.equal(reportResult(report, 3, base, true), 1);
  assert.equal(reportResult(report, 3, base, false), 0);
  assert.throws(() => reportResult(report, 0, base, true), /incomplete or inconsistent/);
  assert.throws(() => reportResult(report, 3, "b".repeat(40), true), /incomplete or inconsistent/);
  assert.throws(() => reportResult("", 1, base, false), /failed before/);
});
