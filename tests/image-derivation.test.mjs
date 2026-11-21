import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// prepare's step that decides whether a job gets the image builder, run as the runner runs it in a
// real Git checkout.
const action = readFileSync(new URL("../actions/prepare/action.yml", import.meta.url), "utf8");
const block = action.split("    - name: Image builds of the job\n")[1].split("\n    - name: ")[0];
const script = block.split("      run: |\n")[1].split("\n").map((line) => line.replace(/^ {8}/, "")).join("\n");
const linux = {skip: process.platform === "linux" ? false : "image builds are Linux-only"};

function decide(files, images, os = "Linux") {
  const root = mkdtempSync(path.join(tmpdir(), "image-derivation-"));
  try {
    const git = (...args) => execFileSync("git", args, {cwd: root, stdio: "pipe"});
    git("init", "-q");
    for (const file of files) {
      mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
      writeFileSync(path.join(root, file), "FROM scratch\n");
    }
    writeFileSync(path.join(root, "untracked.Dockerfile"), "FROM scratch\n");
    if (files.length) git("add", ...files);
    writeFileSync(path.join(root, "output"), "");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {cwd: root, encoding: "utf8",
      env: {PATH: process.env.PATH, IMAGES: images, RUNNER_OS: os, GITHUB_OUTPUT: path.join(root, "output")}});
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(path.join(root, "output"), "utf8");
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

test("a tracked Dockerfile or Containerfile gives the job its image builder", linux, () => {
  for (const file of ["Dockerfile", "deploy/Dockerfile", "docker/Dockerfile.app", "infra/api.Dockerfile",
    "tools/web.dockerfile", "Containerfile", "image/Containerfile.base"])
    assert.equal(decide([file], "auto"), "prepare=true\n", file);
});

test("no tracked Dockerfile, another system or a caller that names it decide as they say", linux, () => {
  assert.equal(decide(["README.md", "docs/dockerfiles.md"], "auto"), "");
  assert.equal(decide([], "auto"), "");
  assert.equal(decide(["Dockerfile"], "auto", "macOS"), "");
  assert.equal(decide([], "true"), "prepare=true\n");
});
