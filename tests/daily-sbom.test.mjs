import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { databases, grypeCache, main } from "../actions/daily-sbom/run.mjs";

// A stand-in for each scanner: it records the database addresses it was given, and writes the
// report its caller expects.
const stub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
if (tool === "grype" && args[0] === "db") {
  const db = path.join(process.env.GRYPE_DB_CACHE_DIR, "6", "vulnerability.db");
  fs.appendFileSync(path.join(path.dirname(process.argv[1]), "db.log"), args.slice(0, 2).join(" ") + "\\n");
  if (args[1] === "import") {
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(db, fs.readFileSync(args[2], "utf8") === "archive" ? "valid" : "other");
    process.exit(0);
  }
  const valid = fs.existsSync(db) && fs.readFileSync(db, "utf8") === "valid";
  process.stdout.write(valid ? "Status:    valid\\n" : "Status:    invalid\\n");
  process.exit(valid ? 0 : 1);
}
fs.appendFileSync(
  path.join(path.dirname(process.argv[1]), "calls.log"),
  JSON.stringify({
    tool,
    grype: process.env.GRYPE_DB_UPDATE_URL ?? null,
    trivy: process.env.TRIVY_DB_REPOSITORY ?? null,
    java: process.env.TRIVY_JAVA_DB_REPOSITORY ?? null,
    cache: process.env.GRYPE_DB_CACHE_DIR ?? null,
  }) + "\\n",
);
if (tool === "syft") {
  const out = args.find((arg) => arg.startsWith("cyclonedx-json=")).slice(15);
  fs.writeFileSync(out, "{}");
}
if (tool === "grype") process.stdout.write(JSON.stringify({ matches: [] }));
if (tool === "trivy") fs.writeFileSync(args[args.indexOf("--output") + 1], "{}");
`;

function job() {
  const root = mkdtempSync(path.join(tmpdir(), "daily-sbom-"));
  const workspace = path.join(root, "checkout");
  const temporary = path.join(root, "temporary");
  const tools = path.join(root, "tools");
  for (const folder of [workspace, temporary, tools]) mkdirSync(folder);
  for (const tool of ["syft", "grype", "trivy"]) {
    writeFileSync(path.join(tools, tool), stub);
    chmodSync(path.join(tools, tool), 0o700);
  }
  const environment = {
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: temporary,
    INPUT_TOOLS: tools,
    INPUT_OUTPUT: path.join(root, "reports"),
  };
  delete environment.NDDEV_CI_ARTIFACT_REGISTRY;
  for (const name of ["GRYPE_DB_UPDATE_URL", "TRIVY_DB_REPOSITORY", "TRIVY_JAVA_DB_REPOSITORY"])
    delete environment[name];
  const calls = () =>
    readFileSync(path.join(tools, "calls.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { root, environment, calls };
}

const linux = {
  skip: process.platform === "linux" ? false : "the daily scan is Linux-only",
};

test("a declared registry gives Grype and Trivy their databases", linux, (t) => {
  const { root, environment, calls } = job();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  environment.NDDEV_CI_ARTIFACT_REGISTRY = "http://127.0.0.1:8740/";
  main(environment, "2026-11-11");
  assert.deepEqual(
    calls().map((call) => call.tool),
    ["syft", "grype", "trivy"],
  );
  for (const call of calls()) {
    assert.equal(call.grype, "http://127.0.0.1:8740/grype/2026-11-11");
    assert.equal(call.trivy, "127.0.0.1:8740/ghcr.io/aquasecurity/trivy-db:2");
    assert.equal(call.java, "127.0.0.1:8740/ghcr.io/aquasecurity/trivy-java-db:1");
  }
});

test("without a declared registry each scanner keeps its own source", linux, (t) => {
  const { root, environment, calls } = job();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  main(environment, "2026-11-11");
  for (const call of calls())
    assert.deepEqual([call.grype, call.trivy, call.java], [null, null, null]);
  assert.deepEqual(databases(environment, "2026-11-11"), {});
  assert.throws(
    () =>
      databases(
        { NDDEV_CI_ARTIFACT_REGISTRY: "http://user@127.0.0.1:8740" },
        "2026-11-11",
      ),
    /Invalid declared security tool registry/,
  );
});

// The registry runs in its own process: the scan blocks this one while it waits for curl.
const grypeRegistry = `
const http = require("node:http");
const fs = require("node:fs");
const crypto = require("node:crypto");
const [log, day] = process.argv.slice(1);
const name = "vulnerability-db_v6.1.10_2026-11-12T00:22:10Z_1794464458.tar.zst";
const server = http.createServer((request, response) => {
  fs.appendFileSync(log, request.url + "\\n");
  if (request.url === "/grype/" + day + "/v6/latest.json")
    response.end(JSON.stringify({ path: name, checksum: "sha256:" + crypto.createHash("sha256").update("archive").digest("hex") }));
  else if (request.url === "/grype/" + day + "/v6/" + name) response.end("archive");
  else { response.statusCode = 404; response.end(); }
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

test("Grype's database is imported once into the runner's cache and checked at every use", linux, async (t) => {
  const { root, environment, calls } = job();
  const log = path.join(root, "registry.log");
  const day = "2026-11-13";
  const server = spawn(process.execPath, ["-e", grypeRegistry, log, day], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => {
    server.kill();
    rmSync(root, { recursive: true, force: true });
  });
  const port = await new Promise((resolve) =>
    server.stdout.once("data", (bytes) => resolve(String(bytes).trim())),
  );
  const cache = path.join(root, "build-cache");
  mkdirSync(cache);
  environment.NDDEV_CI_ARTIFACT_REGISTRY = `http://127.0.0.1:${port}`;
  environment.NDDEV_BUILD_CACHE_ROOT = cache;
  const digest = createHash("sha256").update("archive").digest("hex");
  const database = path.join(cache, "nddev-ci", "grype", digest);
  const requests = () => readFileSync(log, "utf8").trim().split("\n");

  main(environment, day);
  assert.equal(requests().length, 2);
  for (const call of calls().filter((call) => call.tool === "grype"))
    assert.equal(call.cache, database);
  assert.equal(readFileSync(path.join(database, "6", "vulnerability.db"), "utf8"), "valid");

  // The next job reads only the listing and uses the imported database in place.
  grypeCache(environment, day, environment.INPUT_TOOLS);
  assert.equal(requests().length, 3);

  // A database that fails Grype's own check is imported again from the checked archive.
  writeFileSync(path.join(database, "6", "vulnerability.db"), "altered");
  grypeCache(environment, day, environment.INPUT_TOOLS);
  assert.equal(requests().length, 5);
  assert.equal(readFileSync(path.join(database, "6", "vulnerability.db"), "utf8"), "valid");
  assert.deepEqual(readdirSync(path.join(cache, "nddev-ci", "grype")), [digest]);
});
