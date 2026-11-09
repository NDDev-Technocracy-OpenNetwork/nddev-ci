import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { archiveProgram, extract } from "../lib/native-member.mjs";
import { main as recipe } from "../actions/recipe/run.mjs";

test("Windows archives use the native system provider independently of PATH", () => {
  assert.equal(
    archiveProgram({ SystemRoot: "C:\\Windows", PATH: "unrelated" }, "win32"),
    "C:\\Windows\\System32\\tar.exe",
  );
  assert.equal(
    archiveProgram({ SYSTEMROOT: "D:\\Windows" }, "win32"),
    "D:\\Windows\\System32\\tar.exe",
  );
  assert.equal(archiveProgram({}, "linux"), "tar");
  assert.equal(archiveProgram({}, "darwin"), "tar");
  for (const root of [
    undefined,
    "relative",
    "\\\\server\\share",
    "C:\\Windows\\..\\other",
    "C:\\Windows\n",
  ])
    assert.throws(() => archiveProgram({ SystemRoot: root }, "win32"));
});

test("real Windows drive paths and cold Just preparation work with Git GNU tar ahead of system tools", {
  skip: process.platform !== "win32",
  timeout: 180000,
}, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "native-windows-archive-"));
  const previousPath = process.env.PATH;
  try {
    const git = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    const gitTools = path.resolve(git.stdout.trim(), "../../..", "usr", "bin");
    const gnuTar = path.join(gitTools, "tar.exe");
    assert(
      existsSync(gnuTar),
      "the actual Git for Windows archive provider must be available",
    );
    assert.match(
      spawnSync(gnuTar, ["--version"], { encoding: "utf8" }).stdout,
      /GNU tar/,
    );
    const bytes = Buffer.from("exact native bytes\n");
    writeFileSync(path.join(directory, "payload"), bytes);
    const archive = path.join(directory, "source.tar");
    const packed = spawnSync(
      archiveProgram(),
      ["-cf", archive, "-C", directory, "payload"],
      { encoding: "utf8" },
    );
    assert.equal(packed.status, 0, packed.stderr);
    assert.notEqual(
      spawnSync(gnuTar, ["-xOf", archive, "--", "payload"], {
        encoding: "utf8",
      }).status,
      0,
      "the regression fixture must reproduce the GNU drive-letter failure",
    );
    process.env.PATH = `${gitTools}${path.delimiter}${previousPath}`;
    const target = path.join(directory, "prepared");
    await extract(
      archive,
      {
        path: "payload",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      target,
    );
    assert.deepEqual(readFileSync(target), bytes);

    const workspace = path.join(directory, "workspace");
    mkdirSync(workspace);
    writeFileSync(
      path.join(workspace, "justfile"),
      'set shell := ["bash", "-euo", "pipefail", "-c"]\ncheck:\n    @node --version\n',
    );
    await recipe({
      ...process.env,
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_TEMP: path.join(directory, "cold"),
      GITHUB_WORKSPACE: workspace,
      INPUT_JUSTFILE: "justfile",
      INPUT_RECIPE: "check",
      INPUT_ARGUMENTS: "[]",
      "INPUT_WORKING-DIRECTORY": ".",
      "INPUT_GITHUB-TOKEN": process.env.GH_TOKEN ?? "",
      GITHUB_OUTPUT: "",
      GITHUB_PATH: "",
    });
  } finally {
    process.env.PATH = previousPath;
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 100,
    });
  }
});
