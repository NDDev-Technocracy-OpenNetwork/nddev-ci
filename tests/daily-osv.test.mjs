import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../actions/daily-osv/run.mjs";

// A stand-in for the scanner: it reports one npm package when the scanned folder holds a
// package-lock.json, fails an offline run that has no npm database as the real scanner does, and
// only notes a download. Every call is appended to calls.log beside the scanner.
const stubScanner = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const folder = args[args.length - 1];
const kind = args.some((flag) => flag.startsWith("--licenses="))
  ? "licences"
  : args.includes("--download-offline-databases")
    ? "download"
    : args.includes("--all-packages")
      ? "list"
      : "offline";
fs.appendFileSync(path.join(path.dirname(process.argv[1]), "calls.log"), kind + "\\n");
const results = fs.existsSync(path.join(folder, "package-lock.json"))
  ? [{ source: { path: folder, type: "lockfile" }, packages: [{ package: { name: "inert", version: "1.0.0", ecosystem: "npm" } }] }]
  : [];
process.stdout.write(JSON.stringify({ results }));
if (kind === "list" || kind === "offline") {
  const db = args[args.indexOf("--local-db-path") + 1];
  if (process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY !== db) process.exit(2);
  if (results.length && !fs.existsSync(path.join(db, "osv-scalibr", "npm", "all.zip"))) {
    process.stderr.write("unable to fetch OSV database: no offline version of the OSV database is available\\n");
    process.exit(127);
  }
}
`;

// The registry runs in its own process: the scan blocks this one while it waits for curl.
const stubRegistry = `
const http = require("node:http");
const fs = require("node:fs");
const [log, day] = process.argv.slice(1);
const server = http.createServer((request, response) => {
  fs.appendFileSync(log, request.method + " " + request.url + "\\n");
  if (request.url === "/osv/" + day + "/npm/all.zip") response.end("the copy of the day");
  else { response.statusCode = 404; response.end(); }
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

function job() {
  const root = mkdtempSync(path.join(tmpdir(), "daily-osv-"));
  const workspace = path.join(root, "checkout");
  const temporary = path.join(root, "temporary");
  const tools = path.join(root, "tools");
  for (const folder of [workspace, temporary, tools]) mkdirSync(folder);
  writeFileSync(path.join(workspace, "package-lock.json"), "{}");
  const binary = path.join(tools, "scanner");
  writeFileSync(binary, stubScanner);
  chmodSync(binary, 0o700);
  const output = path.join(root, "reports");
  const environment = {
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: temporary,
    INPUT_SCANNER: binary,
    INPUT_OUTPUT: output,
    INPUT_LICENSES: "Apache-2.0",
  };
  delete environment.NDDEV_CI_ARTIFACT_REGISTRY;
  const calls = () =>
    readFileSync(path.join(tools, "calls.log"), "utf8").trim().split("\n");
  return { root, temporary, output, environment, calls };
}

// curl and the executable stand-in follow the Linux runners the daily scan runs on.
const linux = {
  skip: process.platform === "linux" ? false : "the daily scan is Linux-only",
};

test("a declared registry provides the day's databases to the daily scan", linux, async (t) => {
  const { root, temporary, output, environment, calls } = job();
  const log = path.join(root, "registry.log");
  const day = "2026-11-11";
  const registry = spawn(process.execPath, ["-e", stubRegistry, log, day], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => {
    registry.kill();
    rmSync(root, { recursive: true, force: true });
  });
  const port = await new Promise((resolve) =>
    registry.stdout.once("data", (bytes) => resolve(String(bytes).trim())),
  );
  environment.NDDEV_CI_ARTIFACT_REGISTRY = `http://127.0.0.1:${port}/`;
  main(environment, day);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    `GET /osv/${day}/npm/all.zip`,
  ]);
  assert.deepEqual(calls(), ["list", "offline", "licences"]);
  assert.equal(
    JSON.parse(readFileSync(path.join(output, "osv.json"), "utf8")).results
      .length,
    1,
  );
  // The databases and the scanner policy leave with the scan.
  assert.deepEqual(readdirSync(temporary), []);

  // A day the registry does not hold fails the scan; nothing falls back to a download.
  const other = job();
  t.after(() => rmSync(other.root, { recursive: true, force: true }));
  other.environment.NDDEV_CI_ARTIFACT_REGISTRY = `http://127.0.0.1:${port}`;
  assert.throws(
    () => main(other.environment, "2026-11-10"),
    /declared registry could not provide a vulnerability database/,
  );
  assert.deepEqual(other.calls(), ["list"]);
  assert.equal(existsSync(other.output), false);
  assert.deepEqual(readdirSync(other.temporary), []);
});

test("without a declared registry the scanner downloads its own databases", linux, (t) => {
  const { root, temporary, output, environment, calls } = job();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  main(environment);
  assert.deepEqual(calls(), ["download", "licences"]);
  assert.equal(existsSync(path.join(output, "licenses.json")), true);
  assert.deepEqual(readdirSync(temporary), []);
});
