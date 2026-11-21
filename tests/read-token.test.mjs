import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../actions/read-token/run.mjs";
import { mint, repositories } from "../lib/read-token.mjs";

const {privateKey} = generateKeyPairSync("rsa", {modulusLength: 2048});
const pem = privateKey.export({type: "pkcs8", format: "pem"});
const repo = (name, owner = "Org") => ({name, owner: {login: owner}});

// A loopback GitHub that answers the App flow as the case says and records what was asked.
async function github({account = "org", permissions = {contents: "read", metadata: "read"}, pages = [[repo("a"), repo("b")]],
  total = 2} = {}) {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    const send = (status, body) => { response.writeHead(status, {"Content-Type": "application/json"}); response.end(body === undefined ? "" : JSON.stringify(body)); };
    if (request.url === "/app/installations/5") return send(200, {account: {login: account}});
    if (request.url === "/app/installations/5/access_tokens") return send(201, {token: "minted", permissions});
    const page = /^\/installation\/repositories\?per_page=100&page=(\d+)$/.exec(request.url);
    if (page) return send(200, {total_count: total, repositories: pages[Number(page[1]) - 1] ?? []});
    if (request.url === "/installation/token" && request.method === "DELETE") return send(204);
    send(404, {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {api: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close()};
}
const ask = (api, fields = {}) => mint({clientId: "Iv1.client", installationId: "5", requested: "Org/a\nOrg/b",
  privateKey: pem, owner: "org", api, ...fields});

test("a token that reads exactly the named repositories is returned and masked", async () => {
  const server = await github();
  const masked = [];
  try {
    assert.deepEqual(await ask(server.api, {mask: (value) => masked.push(value)}), {token: "minted", count: 2});
    assert.ok(masked.includes("minted") && masked.length === 2);
    assert.ok(!server.calls.includes("DELETE /installation/token"));
  } finally { server.close(); }
});

test("a token that holds more, other or less than asked is revoked at once", async () => {
  for (const [fields, reason] of [
    [{permissions: {contents: "read", issues: "write"}}, /not contents-read only/],
    [{pages: [[repo("a"), repo("c")]]}, /unrequested repository/],
    [{pages: [[repo("a"), repo("b", "Other")]]}, /unrequested repository/],
    [{total: 3, pages: [[repo("a"), repo("b"), repo("c")]]}, /differs from the explicit request/],
    [{pages: [[repo("a")], [repo("a")]]}, /did not advance/],
  ]) {
    const server = await github(fields);
    try {
      await assert.rejects(ask(server.api), reason);
      assert.equal(server.calls.at(-1), "DELETE /installation/token");
    } finally { server.close(); }
  }
});

test("a foreign installation or a malformed request mints nothing", async () => {
  const server = await github({account: "someone-else"});
  try {
    await assert.rejects(ask(server.api), /another organization/);
    assert.ok(!server.calls.some((call) => call.includes("access_tokens")));
    await assert.rejects(ask(server.api, {installationId: "0"}), /installation and explicit read repositories/);
    await assert.rejects(ask(server.api, {privateKey: generateKeyPairSync("ec", {namedCurve: "P-256"}).privateKey.export({type: "pkcs8", format: "pem"})}), /must be RSA/);
  } finally { server.close(); }
  assert.throws(() => repositories("Other/a", "org"), /caller organization/);
  assert.throws(() => repositories("Org/a org/A", "org"), /Duplicate/);
  assert.throws(() => repositories("", "org"), /explicit read repositories/);
  assert.deepEqual(repositories(" Org/a\n\nOrg/b.c ", "org"), ["a", "b.c"]);
});

test("the action writes the token output and keeps the key from later steps", async () => {
  const server = await github();
  const root = mkdtempSync(path.join(tmpdir(), "read-token-"));
  try {
    writeFileSync(path.join(root, "output"), "");
    const environment = {"INPUT_CLIENT-ID": "Iv1.client", "INPUT_INSTALLATION-ID": "5", "INPUT_REPOSITORIES": "Org/a\nOrg/b",
      "INPUT_PRIVATE-KEY": pem, GITHUB_REPOSITORY_OWNER: "Org", GITHUB_API_URL: server.api, GITHUB_OUTPUT: path.join(root, "output")};
    await main(environment);
    assert.equal(readFileSync(path.join(root, "output"), "utf8"), "token=minted\n");
    assert.equal(environment["INPUT_PRIVATE-KEY"], undefined);
  } finally { server.close(); rmSync(root, {recursive: true, force: true}); }
});
