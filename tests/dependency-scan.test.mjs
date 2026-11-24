import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHash } from "node:crypto";
import {
  prepareScanner,
  scannerPin,
  scannerPins,
  scanSources,
} from "../lib/dependency-scan.mjs";

test("each supported native Linux architecture selects its own pinned scanner", () => {
  assert.equal(scannerPin("linux", "x64"), scannerPins.x64);
  assert.equal(scannerPin("linux", "x64").name, "osv-scanner_linux_amd64");
  assert.equal(scannerPin("linux", "arm64"), scannerPins.arm64);
  assert.equal(scannerPin("linux", "arm64").name, "osv-scanner_linux_arm64");
  for (const pin of Object.values(scannerPins)) {
    assert.equal(pin.version, "2.7.1");
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(pin.asset) && pin.asset > 0);
    assert.ok(Number.isSafeInteger(pin.size) && pin.size > 0);
  }
  assert.notEqual(scannerPins.x64.sha256, scannerPins.arm64.sha256);
});

test("unsupported platforms and architectures refuse before any download", () => {
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["win32", "x64"],
    ["linux", "ia32"],
    ["linux", "__proto__"],
    ["linux", "toString"],
  ])
    assert.throws(
      () => scannerPin(platform, arch),
      /requires a native Linux x64 or ARM64 runner/,
    );
});

// A stand-in for the scanner: it reports one npm package for every package-lock.json below the
// scanned folder, fails an offline run that has no npm database as the real scanner does, and
// "downloads" by writing the database file itself. Every call is appended to calls.log.
const stubScanner = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const db = args[args.indexOf("--local-db-path") + 1];
const folder = args[args.indexOf("-r") + 1];
const download = args.includes("--download-offline-databases");
if (!args.includes("--offline")) {
  process.stdout.write(JSON.stringify({ results: [{ source: { path: path.join(folder, "head/package-lock.json"), type: "unknown" }, packages: [] }] }));
  process.exit(0);
}
fs.appendFileSync(path.join(path.dirname(db), "calls.log"), (download ? "download " : "offline ") + path.basename(folder) + "\\n");
const file = path.join(db, "osv-scalibr", "npm", "all.zip");
if (download) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "downloaded by the scanner");
}
const results = [];
(function visit(at) {
  for (const name of fs.readdirSync(at).sort()) {
    const next = path.join(at, name);
    if (fs.statSync(next).isDirectory()) visit(next);
    else if (name === "package-lock.json")
      results.push({ source: { path: next, type: "lockfile" }, packages: [{ package: { name: "inert", version: "1.0.0", ecosystem: "npm" } }] });
  }
})(folder);
process.stdout.write(JSON.stringify({ results }));
if (results.length && !fs.existsSync(file)) {
  process.stderr.write("unable to fetch OSV database: no offline version of the OSV database is available\\n");
  process.exit(127);
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

function comparison() {
  const root = mkdtempSync(path.join(tmpdir(), "dependency-scan-"));
  for (const side of ["base", "head"]) {
    mkdirSync(path.join(root, "inputs", side), { recursive: true });
    writeFileSync(path.join(root, "inputs", side, "package-lock.json"), "{}");
  }
  const binary = path.join(root, "scanner");
  writeFileSync(binary, stubScanner);
  chmodSync(binary, 0o700);
  const input = {
    base: [{ path: "package-lock.json" }],
    head: [{ path: "package-lock.json" }],
    renames: new Map(),
  };
  const calls = () =>
    readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n");
  return { root, binary, input, calls };
}

// The comparison names its pinned scanner in the result, which exists for native Linux only.
const linux = {
  skip:
    process.platform === "linux" ? false : "the dependency guard is Linux-only",
};

async function startStubRegistry(t, root, day, extraEnv = {}) {
  const log = path.join(root, "registry.log");
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
  return {
    log,
    environment: {
      ...process.env,
      NDDEV_CI_ARTIFACT_REGISTRY: `http://127.0.0.1:${port}/`,
      ...extraEnv,
    },
  };
}

test("a declared registry provides the day's databases and the scanner downloads nothing", linux, async (t) => {
  const { root, binary, input, calls } = comparison();
  const day = "2026-11-10";
  const { log, environment } = await startStubRegistry(t, root, day);
  const result = await scanSources(binary, root, input, environment, day);
  assert.deepEqual(
    result.databases.map((entry) => entry.path),
    ["osv-scalibr/npm/all.zip"],
  );
  assert.equal(
    readFileSync(
      path.join(root, "database", "osv-scalibr", "npm", "all.zip"),
      "utf8",
    ),
    "the copy of the day",
  );
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    `GET /osv/${day}/npm/all.zip`,
  ]);
  assert.deepEqual(calls(), [
    "offline inputs",
    "offline inputs",
    "offline base",
    "offline head",
  ]);

  // A day the registry does not hold fails the comparison; nothing falls back to a download.
  const other = comparison();
  t.after(() => rmSync(other.root, { recursive: true, force: true }));
  await assert.rejects(
    scanSources(
      other.binary,
      other.root,
      other.input,
      environment,
      "2026-11-09",
    ),
    /declared registry could not provide a vulnerability database/,
  );
  assert.deepEqual(other.calls(), ["offline inputs"]);
});

test("without a declared registry the scanner downloads its databases once", linux, async (t) => {
  const { root, binary, input, calls } = comparison();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment = { ...process.env };
  delete environment.NDDEV_CI_ARTIFACT_REGISTRY;
  const result = await scanSources(binary, root, input, environment);
  assert.equal(result.databases.length, 1);
  assert.deepEqual(calls(), [
    "download inputs",
    "offline base",
    "offline head",
  ]);
});

test("a declared registry caches daily databases under NDDEV_BUILD_CACHE_ROOT and prunes stale days", linux, async (t) => {
  const { root, binary, input } = comparison();
  const cacheRoot = path.join(root, "build-cache");
  const stale = path.join(cacheRoot, "osv-databases", "2026-11-09", "npm");
  mkdirSync(stale, { recursive: true });
  writeFileSync(path.join(stale, "all.zip"), "stale");
  const day = "2026-11-10";
  const { log, environment } = await startStubRegistry(t, root, day, {
    NDDEV_BUILD_CACHE_ROOT: cacheRoot,
  });
  await scanSources(binary, root, input, environment, day);
  assert.equal(readFileSync(log, "utf8").trim(), `GET /osv/${day}/npm/all.zip`);
  assert.throws(() => readFileSync(path.join(stale, "all.zip")));

  // A second scan on the same UTC day reuses the cached zip with zero registry requests.
  const second = comparison();
  t.after(() => rmSync(second.root, { recursive: true, force: true }));
  const result = await scanSources(second.binary, second.root, second.input, environment, day);
  assert.equal(result.databases.length, 1);
  assert.equal(readFileSync(log, "utf8").trim(), `GET /osv/${day}/npm/all.zip`);
});

test("prepareScanner reuses an exact preinstalled scanner on PATH without downloading", linux, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "dependency-preinstalled-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, "sdk-bin");
  mkdirSync(binDir, { recursive: true });
  const preinstalled = path.join(binDir, "osv-scanner");
  const body = `#!${process.execPath}\nconsole.log("osv-scanner version: 2.7.1");\n`;
  writeFileSync(preinstalled, body);
  chmodSync(preinstalled, 0o755);
  const bytes = Buffer.from(body);
  const pin = {
    version: "2.7.1",
    repository: "google/osv-scanner",
    tag: "v2.7.1",
    name: "osv-scanner_linux_amd64",
    asset: 1,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const found = await prepareScanner(
    path.join(root, "work"),
    { PATH: `${binDir}:${process.env.PATH || ""}`, NDDEV_CI_ARTIFACT_REGISTRY: "http://127.0.0.1:1" },
    pin,
  );
  assert.equal(found, preinstalled);

  // A mismatched digest on PATH must not be trusted and must fall through to the registry.
  await assert.rejects(
    prepareScanner(
      path.join(root, "work2"),
      { PATH: `${binDir}:${process.env.PATH || ""}`, NDDEV_CI_ARTIFACT_REGISTRY: "http://127.0.0.1:1" },
      { ...pin, sha256: "0".repeat(64) },
    ),
    /could not provide the pinned scanner/,
  );
});
