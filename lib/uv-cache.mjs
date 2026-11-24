import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PYPI_FILES_PREFIX = "https://files.pythonhosted.org/";
const MARKER_DIR_NAME = ".nddev-warmed";
const MARKER_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export function normalizeRegistryOrigin(raw) {
  if (!raw || /[\r\n\0]/.test(raw)) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return "";
  if (parsed.username || parsed.password) return "";
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

export function findUvLockfiles(workspace, workingDirectory = ".") {
  let root = workspace;
  if (workingDirectory && workingDirectory !== ".") {
    const candidate = path.resolve(workspace, workingDirectory);
    if (!candidate.startsWith(path.resolve(workspace) + path.sep) && candidate !== path.resolve(workspace)) {
      return [];
    }
    root = candidate;
  }
  if (!existsSync(root)) return [];
  const listed = spawnSync(
    "git",
    ["-C", root, "ls-files", "-z", "--", "uv.lock", "*/uv.lock", "*/*/uv.lock"],
    { encoding: "utf8", timeout: 15000, maxBuffer: 1048576, windowsHide: true },
  );
  const candidates =
    listed.status === 0
      ? listed.stdout.split("\0").filter(Boolean).map((rel) => path.join(root, rel))
      : existsSync(path.join(root, "uv.lock"))
        ? [path.join(root, "uv.lock")]
        : [];
  return candidates
    .filter((lockPath) => existsSync(lockPath) && existsSync(path.join(path.dirname(lockPath), "pyproject.toml")))
    .sort();
}

function parseTopField(block, field) {
  const match = block.match(new RegExp(`^${field}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m"));
  return match ? match[1] : "";
}

function parseWheelEntries(block) {
  const start = block.match(/^wheels\s*=\s*\[/m);
  if (!start) return [];
  const after = block.slice(start.index + start[0].length);
  const end = after.indexOf("\n]");
  const body = end === -1 ? after : after.slice(0, end);
  const entries = [];
  const linePattern = /\{[^\n]*?\burl\s*=\s*"([^"]+)"[^\n]*?\bsha256\s*=\s*"([a-f0-9]{64})"[^\n]*?\}/g;
  for (const match of body.matchAll(linePattern)) {
    const [, url, sha256] = match;
    if (url.startsWith(PYPI_FILES_PREFIX)) {
      entries.push({ url, sha256 });
    }
  }
  return entries;
}

/**
 * Keep only wheel-backed PyPI packages from a `uv export --format pylock.toml` document,
 * rewrite their wheel URLs to `<registryOrigin>/pypi-files/`, and preserve `index` so uv
 * keys its cache identically to `uv sync --locked`.
 */
export function rewritePylockForRegistry(sourceText, registryOrigin) {
  const base = normalizeRegistryOrigin(registryOrigin);
  if (!base) throw new Error("Invalid artifact registry URL.");
  const parts = sourceText.split(/\r?\n\[\[packages\]\]\r?\n/);
  const header = parts[0] ?? "";
  const lines = ['lock-version = "1.0"', 'created-by = "uv"'];
  const requiresPython = parseTopField(header, "requires-python");
  if (requiresPython) lines.push(`requires-python = "${requiresPython}"`);

  let kept = 0;
  let skipped = 0;
  for (const block of parts.slice(1)) {
    const name = parseTopField(block, "name");
    const version = parseTopField(block, "version");
    const index = parseTopField(block, "index");
    const marker = parseTopField(block, "marker");
    const wheels = parseWheelEntries(block);
    if (!name || !version || wheels.length === 0) {
      skipped += 1;
      continue;
    }
    kept += 1;
    lines.push("", "[[packages]]");
    lines.push(`name = "${name}"`);
    lines.push(`version = "${version}"`);
    if (index) lines.push(`index = "${index}"`);
    if (marker) lines.push(`marker = "${marker}"`);
    lines.push("wheels = [");
    for (const wheel of wheels) {
      const mirrored = `${base}/pypi-files/${wheel.url.slice(PYPI_FILES_PREFIX.length)}`;
      lines.push(`  { url = "${mirrored}", hashes = { sha256 = "${wheel.sha256}" } },`);
    }
    lines.push("]");
  }
  return { text: `${lines.join("\n")}\n`, kept, skipped };
}

function pruneMarkers(markerDir, nowMs) {
  if (!existsSync(markerDir)) return;
  for (const entry of readdirSync(markerDir)) {
    const target = path.join(markerDir, entry);
    try {
      const info = statSync(target);
      if (info.isFile() && nowMs - info.mtimeMs > MARKER_MAX_AGE_MS) {
        rmSync(target, { force: true });
      }
    } catch {
      // Ignore concurrent cleanup or unreadable entries.
    }
  }
}

function exportPylock(projectDir, outputFile, env) {
  const attempts = [
    ["--all-groups", "--all-extras"],
    ["--all-groups"],
    [],
  ];
  for (const flags of attempts) {
    const result = spawnSync(
      "uv",
      [
        "export",
        "--directory",
        projectDir,
        "--offline",
        "--frozen",
        ...flags,
        "--no-emit-project",
        "--no-header",
        "--no-annotate",
        "--format",
        "pylock.toml",
        "--output-file",
        outputFile,
      ],
      { env, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    );
    if (result.status === 0 && existsSync(outputFile)) return true;
  }
  return false;
}

export function warmUvCaches(environment = process.env, log = console.log) {
  const registry = normalizeRegistryOrigin(environment.NDDEV_CI_ARTIFACT_REGISTRY || "");
  const cacheDir = environment.UV_CACHE_DIR || "";
  const workspace = environment.GITHUB_WORKSPACE || process.cwd();
  if (!registry || !cacheDir || !path.isAbsolute(cacheDir)) {
    return { warmed: 0, skippedWarm: 0, failed: 0 };
  }

  const lockfiles = findUvLockfiles(workspace, environment["INPUT_WORKING-DIRECTORY"] || ".");
  if (lockfiles.length === 0) return { warmed: 0, skippedWarm: 0, failed: 0 };

  const probe = spawnSync("uv", ["--version"], {
    env: environment,
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  if (probe.error || probe.status !== 0) return { warmed: 0, skippedWarm: 0, failed: 0 };
  const uvVersion = `${probe.stdout ?? ""}`.trim();
  const pythonId = environment.UV_PYTHON || "";
  const markerDir = path.join(cacheDir, MARKER_DIR_NAME);
  const uvEnv = { ...environment, UV_PYTHON_DOWNLOADS: "never" };

  let warmed = 0;
  let skippedWarm = 0;
  let failed = 0;

  for (const lockPath of lockfiles) {
    const projectDir = path.dirname(lockPath);
    const label = path.relative(workspace, lockPath) || "uv.lock";
    const key = createHash("sha256")
      .update("nddev-uv-warm-v1\0")
      .update(readFileSync(lockPath))
      .update(`\0${uvVersion}\0${pythonId}\0${process.platform}\0${process.arch}\0${registry}\0`)
      .digest("hex");
    const markerPath = path.join(markerDir, key);
    if (existsSync(markerPath) && existsSync(path.join(cacheDir, "archive-v0"))) {
      log(`uv cache already warm for ${label}.`);
      skippedWarm += 1;
      continue;
    }

    const scratch = mkdtempSync(path.join(environment.RUNNER_TEMP || tmpdir(), "nddev-uv-warm-"));
    try {
      const sourcePylock = path.join(scratch, "pylock.source.toml");
      if (!exportPylock(projectDir, sourcePylock, uvEnv)) {
        log(`::warning::Could not export ${label} to pylock.toml; skipping uv cache warm.`);
        failed += 1;
        continue;
      }
      const rewritten = rewritePylockForRegistry(readFileSync(sourcePylock, "utf8"), registry);
      if (rewritten.kept === 0) {
        skippedWarm += 1;
        continue;
      }
      const mirrorPylock = path.join(scratch, "pylock.toml");
      writeFileSync(mirrorPylock, rewritten.text);
      const venvDir = path.join(scratch, "venv");
      const venv = spawnSync("uv", ["venv", "--directory", projectDir, venvDir], {
        env: uvEnv,
        encoding: "utf8",
        timeout: 60000,
        windowsHide: true,
      });
      if (venv.status !== 0) {
        log(`::warning::Could not create temporary uv environment for ${label}; skipping cache warm.`);
        failed += 1;
        continue;
      }
      const venvPython =
        process.platform === "win32"
          ? path.join(venvDir, "Scripts", "python.exe")
          : path.join(venvDir, "bin", "python");
      const sync = spawnSync(
        "uv",
        [
          "--no-config",
          "--preview-features",
          "pylock",
          "pip",
          "sync",
          "--python",
          venvPython,
          "--no-index",
          "--require-hashes",
          "--no-build",
          mirrorPylock,
        ],
        { env: uvEnv, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      );
      if (sync.status !== 0) {
        const detail = `${sync.stderr || sync.stdout || ""}`.trim().split(/\r?\n/).slice(-3).join(" ");
        log(`::warning::uv wheel warm skipped for ${label}: ${detail}`);
        failed += 1;
        continue;
      }
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(markerPath, `${new Date().toISOString()}\n`);
      pruneMarkers(markerDir, Date.now());
      log(`Warmed ${rewritten.kept} locked uv wheel package(s) for ${label} through the artifact registry.`);
      warmed += 1;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return { warmed, skippedWarm, failed };
}
