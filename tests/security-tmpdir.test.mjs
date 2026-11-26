import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { main as dailyOsv } from "../actions/daily-osv/run.mjs";
import { main as dailySbom } from "../actions/daily-sbom/run.mjs";

const workflow = readFileSync(
  new URL("../.github/workflows/security.yml", import.meta.url),
  "utf8",
);

function extractStepScript(name) {
  const marker = `      - name: ${name}\n`;
  const parts = workflow.split(marker);
  assert.equal(parts.length, 2, `workflow defines step ${name}`);
  const step = parts[1].split("\n      - ")[0];
  const match = step.match(/^        run: \|[^\n]*\n([\s\S]*)$/m);
  assert(match, `step ${name} has a shell script`);
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
}

function parseEnvFile(text) {
  return Object.fromEntries(
    text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf("=");
        assert.notEqual(at, -1, `valid KEY=VALUE line: ${line}`);
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

const linux = {
  skip: process.platform === "linux" ? false : "the daily scan is Linux-only",
};

test("security.yml configures RUNNER_TEMP TMPDIR before checkout and every scanner step", () => {
  const platformIndex = workflow.indexOf("      - name: Native scanner platform\n");
  assert.notEqual(platformIndex, -1);
  for (const later of [
    "      - uses: actions/checkout@",
    "      - name: Tools\n",
    "      - name: Secrets\n",
    "      - name: Licence policy\n",
    "      - name: Dependencies and licences\n",
    "      - name: Packages\n",
    "      - name: Report\n",
  ]) {
    const index = workflow.indexOf(later);
    assert.notEqual(index, -1, `workflow includes ${later.trim()}`);
    assert.ok(
      platformIndex < index,
      `Native scanner platform must run before ${later.trim()}`,
    );
  }
  assert.doesNotMatch(workflow, /^\s*(?:TMPDIR|TEMP|TMP):\s*\/tmp\b/m);
});

test("Native scanner platform creates a private security/tmp directory under RUNNER_TEMP and exports TMPDIR, TEMP and TMP", linux, (t) => {
  const script = extractStepScript("Native scanner platform");
  for (const isPrivate of ["true", "false"]) {
    const root = mkdtempSync(path.join(tmpdir(), "security-tmpdir-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const runnerTemp = path.join(root, "runner temporary");
    mkdirSync(runnerTemp, { recursive: true });
    const envFile = path.join(root, "github.env");

    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_OS: "Linux",
        RUNNER_TEMP: runnerTemp,
        GITHUB_ENV: envFile,
        PRIVATE: isPrivate,
        HOSTED_RUNNER: "ubuntu-24.04",
        TMPDIR: "/tmp",
        TEMP: "/tmp",
        TMP: "/tmp",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(runnerTemp, "nddev-ci-started")), true);

    const expectedTmp = path.join(runnerTemp, "security", "tmp");
    assert.equal(existsSync(expectedTmp), true);
    const stats = statSync(expectedTmp);
    assert.equal(stats.isDirectory(), true);
    assert.equal(stats.mode & 0o777, 0o700);

    assert.equal(existsSync(envFile), true);
    const exported = parseEnvFile(readFileSync(envFile, "utf8"));
    assert.deepEqual(exported, {
      TMPDIR: expectedTmp,
      TEMP: expectedTmp,
      TMP: expectedTmp,
    });
  }
});

test("Native scanner platform refuses missing, relative or multiline RUNNER_TEMP without writing GITHUB_ENV", linux, (t) => {
  const script = extractStepScript("Native scanner platform");
  const root = mkdtempSync(path.join(tmpdir(), "security-tmpdir-bad-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const relativeDir = "relative/temp";
  const lfDir = path.join(root, "line1\nINJECTED=1");
  const crDir = path.join(root, "line1\rINJECTED=1");
  for (const dir of [path.join(root, relativeDir), lfDir, crDir])
    mkdirSync(dir, { recursive: true });
  for (const badTemp of ["", relativeDir, lfDir, crDir]) {
    const envFile = path.join(root, `github-${Math.random().toString(36).slice(2)}.env`);
    const env = {
      ...process.env,
      RUNNER_OS: "Linux",
      RUNNER_TEMP: badTemp,
      GITHUB_ENV: envFile,
      PRIVATE: "true",
      HOSTED_RUNNER: "ubuntu-24.04",
    };

    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    assert.notEqual(result.status, 0, `expected failure for RUNNER_TEMP=${JSON.stringify(badTemp)}`);
    assert.equal(existsSync(envFile), false);
  }
});

test("daily-osv forwards TMPDIR, TEMP and TMP to every osv-scanner invocation", linux, (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "security-tmpdir-osv-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "checkout");
  const runnerTemp = path.join(root, "runner temp");
  const expectedTmp = path.join(runnerTemp, "security", "tmp");
  const tools = path.join(root, "tools");
  const output = path.join(root, "reports");
  for (const folder of [workspace, expectedTmp, tools])
    mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(workspace, "package-lock.json"), "{}");

  const log = path.join(root, "osv-env.jsonl");
  const stub = path.join(tools, "osv-scanner");
  writeFileSync(
    stub,
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  TMPDIR: process.env.TMPDIR ?? null,
  TEMP: process.env.TEMP ?? null,
  TMP: process.env.TMP ?? null,
}) + "\\n");
process.stdout.write(JSON.stringify({ results: [] }));
`,
  );
  chmodSync(stub, 0o700);

  const env = {
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    TMPDIR: expectedTmp,
    TEMP: expectedTmp,
    TMP: expectedTmp,
    INPUT_SCANNER: stub,
    INPUT_OUTPUT: output,
    INPUT_LICENSES: "Apache-2.0",
  };
  delete env.NDDEV_CI_ARTIFACT_REGISTRY;

  dailyOsv(env, "2026-11-11");

  const seen = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(seen.length, 2);
  for (const entry of seen) {
    assert.deepEqual(entry, {
      TMPDIR: expectedTmp,
      TEMP: expectedTmp,
      TMP: expectedTmp,
    });
  }
});

const grypeRegistry = `
const http = require("node:http");
const crypto = require("node:crypto");
const [day] = process.argv.slice(1);
const name = "vulnerability-db_v6.1.10_2026-11-12T00:22:10Z_1794464458.tar.zst";
const server = http.createServer((request, response) => {
  if (request.url === "/grype/" + day + "/v6/latest.json")
    response.end(JSON.stringify({ path: name, checksum: "sha256:" + crypto.createHash("sha256").update("archive").digest("hex") }));
  else if (request.url === "/grype/" + day + "/v6/" + name) response.end("archive");
  else { response.statusCode = 404; response.end(); }
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

test("daily-sbom forwards TMPDIR, TEMP and TMP to syft, grype and trivy including cache import", linux, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "security-tmpdir-sbom-"));
  const day = "2026-11-13";
  const server = spawn(process.execPath, ["-e", grypeRegistry, day], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => {
    server.kill();
    rmSync(root, { recursive: true, force: true });
  });
  const port = await new Promise((resolve) =>
    server.stdout.once("data", (bytes) => resolve(String(bytes).trim())),
  );

  const workspace = path.join(root, "checkout");
  const runnerTemp = path.join(root, "runner temp");
  const expectedTmp = path.join(runnerTemp, "security", "tmp");
  const cache = path.join(root, "build-cache");
  const tools = path.join(root, "tools");
  const output = path.join(root, "reports");
  for (const folder of [workspace, expectedTmp, cache, tools])
    mkdirSync(folder, { recursive: true });

  const log = path.join(root, "sbom-env.jsonl");
  const stub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  tool,
  sub: args[0] === "db" ? args.slice(0, 2).join(" ") : "scan",
  TMPDIR: process.env.TMPDIR ?? null,
  TEMP: process.env.TEMP ?? null,
  TMP: process.env.TMP ?? null,
}) + "\\n");
if (tool === "grype" && args[0] === "db") {
  const db = path.join(process.env.GRYPE_DB_CACHE_DIR, "6", "vulnerability.db");
  if (args[1] === "import") {
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(db, "valid");
    process.exit(0);
  }
  const valid = fs.existsSync(db) && fs.readFileSync(db, "utf8") === "valid";
  process.stdout.write(valid ? "Status:    valid\\n" : "Status:    invalid\\n");
  process.exit(valid ? 0 : 1);
}
if (tool === "syft") {
  const out = args.find((arg) => arg.startsWith("cyclonedx-json=")).slice(15);
  fs.writeFileSync(out, "{}");
}
if (tool === "grype") process.stdout.write(JSON.stringify({ matches: [] }));
if (tool === "trivy") fs.writeFileSync(args[args.indexOf("--output") + 1], "{}");
`;
  for (const tool of ["syft", "grype", "trivy"]) {
    const target = path.join(tools, tool);
    writeFileSync(target, stub);
    chmodSync(target, 0o700);
  }

  const env = {
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    TMPDIR: expectedTmp,
    TEMP: expectedTmp,
    TMP: expectedTmp,
    NDDEV_CI_ARTIFACT_REGISTRY: `http://127.0.0.1:${port}`,
    NDDEV_BUILD_CACHE_ROOT: cache,
    INPUT_TOOLS: tools,
    INPUT_OUTPUT: output,
  };
  delete env.GRYPE_DB_UPDATE_URL;
  delete env.TRIVY_DB_REPOSITORY;
  delete env.TRIVY_JAVA_DB_REPOSITORY;

  dailySbom(env, day);

  const seen = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    seen.map((entry) => `${entry.tool}:${entry.sub}`),
    [
      "grype:db status",
      "grype:db import",
      "grype:db status",
      "syft:scan",
      "grype:scan",
      "trivy:scan",
    ],
  );
  for (const entry of seen) {
    assert.deepEqual(
      { TMPDIR: entry.TMPDIR, TEMP: entry.TEMP, TMP: entry.TMP },
      { TMPDIR: expectedTmp, TEMP: expectedTmp, TMP: expectedTmp },
    );
  }
});
