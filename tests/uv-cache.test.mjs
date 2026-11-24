import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findUvLockfiles,
  normalizeRegistryOrigin,
  rewritePylockForRegistry,
  warmUvCaches,
} from "../lib/uv-cache.mjs";

test("normalizeRegistryOrigin accepts http/https origins and rejects credentials or control chars", () => {
  assert.equal(normalizeRegistryOrigin("http://127.0.0.1:8740/"), "http://127.0.0.1:8740");
  assert.equal(normalizeRegistryOrigin("https://cache.example/base/"), "https://cache.example/base");
  assert.equal(normalizeRegistryOrigin(["http://", "u", ":", "p", "@127.0.0.1:8740"].join("")), "");
  assert.equal(normalizeRegistryOrigin("ftp://127.0.0.1:8740"), "");
  assert.equal(normalizeRegistryOrigin("http://127.0.0.1:8740\nX=1"), "");
});

test("rewritePylockForRegistry keeps only PyPI wheel packages, rewrites URLs, and drops sdists", () => {
  const shaA = "a".repeat(64);
  const shaB = "b".repeat(64);
  const input = [
    'lock-version = "1.0"',
    'created-by = "uv"',
    'requires-python = ">=3.12"',
    "",
    "[[packages]]",
    'name = "ruff"',
    'version = "0.17.6"',
    'index = "https://pypi.org/simple"',
    'sdist = { url = "https://files.pythonhosted.org/packages/aa/ruff-0.17.6.tar.gz", hashes = { sha256 = "' + shaB + '" } }',
    "wheels = [",
    '    { url = "https://files.pythonhosted.org/packages/be/48/ruff-0.17.6-py3-none-manylinux_2_17_x86_64.whl", size = 1000, hashes = { sha256 = "' + shaA + '" } },',
    "]",
    "",
    "[[packages]]",
    'name = "sdist-only"',
    'version = "1.0.0"',
    'index = "https://pypi.org/simple"',
    'sdist = { url = "https://files.pythonhosted.org/packages/cc/sdist-only-1.0.0.tar.gz", hashes = { sha256 = "' + shaB + '" } }',
    "",
  ].join("\n");
  const out = rewritePylockForRegistry(input, "http://127.0.0.1:8740/");
  assert.equal(out.kept, 1);
  assert.equal(out.skipped, 1);
  assert.match(out.text, /index = "https:\/\/pypi\.org\/simple"/);
  assert.match(out.text, /http:\/\/127\.0\.0\.1:8740\/pypi-files\/packages\/be\/48\/ruff-0\.17\.6/);
  assert.doesNotMatch(out.text, /files\.pythonhosted\.org/);
  assert.doesNotMatch(out.text, /sdist-only/);
  assert.doesNotMatch(out.text, /\bsdist\s*=/);
});

test("findUvLockfiles finds tracked uv.lock files with sibling pyproject.toml", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "uv-lock-find-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "python"), { recursive: true });
  mkdirSync(path.join(root, "orphan"), { recursive: true });
  writeFileSync(path.join(root, "python", "pyproject.toml"), "[project]\nname = 'a'\nversion = '0.1.0'\n");
  writeFileSync(path.join(root, "python", "uv.lock"), "version = 1\n");
  writeFileSync(path.join(root, "orphan", "uv.lock"), "version = 1\n");
  spawnSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
  spawnSync("git", ["-C", root, "add", "python", "orphan"], { stdio: "ignore" });
  assert.deepEqual(findUvLockfiles(root), [path.join(root, "python", "uv.lock")]);
});

test("warmUvCaches serves locked wheels from the registry and short-circuits warm slots", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "uv-warm-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cacheDir = path.join(root, "uv-cache");
  const binDir = path.join(root, "bin");
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(path.join(root, "repo", "python"), { recursive: true });
  writeFileSync(path.join(root, "repo", "python", "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  writeFileSync(path.join(root, "repo", "python", "uv.lock"), "version = 1\n");
  spawnSync("git", ["-C", path.join(root, "repo"), "init", "-q"], { stdio: "ignore" });
  spawnSync("git", ["-C", path.join(root, "repo"), "add", "python"], { stdio: "ignore" });

  const callsLog = path.join(root, "uv-calls.log");
  const wheelSha = createHash("sha256").update("wheel-bytes").digest("hex");
  const fakeUv = path.join(binDir, "uv");
  const fakeScript = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(callsLog)}, args[0] + " " + (args[1] || "") + "\\n");`,
    'if (args[0] === "--version") { console.log("uv 0.13.9"); process.exit(0); }',
    'if (args[0] === "export") {',
    '  const out = args[args.indexOf("--output-file") + 1];',
    `  fs.writeFileSync(out, 'lock-version = "1.0"\\ncreated-by = "uv"\\n\\n[[packages]]\\nname = "demo-pkg"\\nversion = "1.0.0"\\nindex = "https://pypi.org/simple"\\nwheels = [\\n  { url = "https://files.pythonhosted.org/packages/ab/cd/demo_pkg-1.0.0-py3-none-any.whl", hashes = { sha256 = "${wheelSha}" } },\\n]\\n');`,
    '  process.exit(0);',
    '}',
    'if (args[0] === "venv") {',
    '  const dir = args[args.length - 1];',
    '  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });',
    '  fs.writeFileSync(path.join(dir, "bin", "python"), "");',
    '  process.exit(0);',
    '}',
    'if (args.includes("pip") && args.includes("sync")) {',
    '  const pylock = fs.readFileSync(args[args.length - 1], "utf8");',
    '  if (!pylock.includes("/pypi-files/packages/ab/cd/demo_pkg-1.0.0-py3-none-any.whl")) process.exit(2);',
    '  fs.mkdirSync(path.join(process.env.UV_CACHE_DIR, "archive-v0"), { recursive: true });',
    '  process.exit(0);',
    '}',
  ].join("\n");
  writeFileSync(fakeUv, fakeScript, { mode: 0o755 });

  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const env = {
    PATH: `${binDir}:${process.env.PATH || ""}`,
    GITHUB_WORKSPACE: path.join(root, "repo"),
    UV_CACHE_DIR: cacheDir,
    RUNNER_TEMP: root,
    NDDEV_CI_ARTIFACT_REGISTRY: `http://127.0.0.1:${port}`,
  };
  const messages = [];
  const first = warmUvCaches(env, (msg) => messages.push(msg));
  assert.deepEqual(first, { warmed: 1, skippedWarm: 0, failed: 0 });
  assert.ok(existsSync(path.join(cacheDir, ".nddev-warmed")));
  const callsAfterFirst = readFileSync(callsLog, "utf8").trim().split("\n");
  assert.equal(callsAfterFirst.filter((line) => line.startsWith("export")).length, 1);

  const second = warmUvCaches(env, (msg) => messages.push(msg));
  assert.deepEqual(second, { warmed: 0, skippedWarm: 1, failed: 0 });
  const callsAfterSecond = readFileSync(callsLog, "utf8").trim().split("\n");
  assert.equal(callsAfterSecond.filter((line) => line.startsWith("export")).length, 1);
});
