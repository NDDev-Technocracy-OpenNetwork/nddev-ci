import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const action = readFileSync(new URL("../actions/image-builder/action.yml", import.meta.url), "utf8");
const managed = action.split("    - name: Use the runner's persistent builder\n")[1].split("\n    - name: ")[0];
const script = managed.split("      run: |\n")[1].split("\n").map(line => line.replace(/^ {8}/, "")).join("\n");
const linux = {skip: process.platform !== "linux"};

function select(builder, { dockerStatus = "0", driver = "docker", config = "/runner/buildx" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "image-builder-"));
  try {
    const bin = path.join(root, "bin");
    const output = path.join(root, "output");
    const calls = path.join(root, "calls");
    mkdirSync(bin);
    writeFileSync(output, "");
    writeFileSync(path.join(bin, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$DOCKER_CALLS"\nprintf "Driver:  %s\\n" "$DOCKER_DRIVER"\nexit "$DOCKER_STATUS"\n');
    chmodSync(path.join(bin, "docker"), 0o755);
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: { PATH: bin + ":" + process.env.PATH, BUILDX_BUILDER: builder, BUILDX_CONFIG: config,
        GITHUB_OUTPUT: output, DOCKER_CALLS: calls, DOCKER_STATUS: dockerStatus, DOCKER_DRIVER: driver },
    });
    return { ...result, output: readFileSync(output, "utf8"),
      calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
  } finally { rmSync(root, {recursive: true, force: true}); }
}

test("managed jobs inspect the existing Docker or BuildKit builder", linux, () => {
  for (const result of [select("default"), select("default", { driver: "remote" })]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls, "buildx\ninspect\n--\ndefault\n");
    assert.equal(result.output, "name=default\n");
  }
});

test("a missing or malformed builder does not invoke Docker", linux, () => {
  for (const name of ["", "-replace", "line\nname=another"]) {
    const result = select(name);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /BUILDX_BUILDER/);
    assert.equal(result.calls, "");
    assert.equal(result.output, "");
  }
});

test("a declared builder unavailable on the daemon stops the managed step", linux, () => {
  const result = select("default", { dockerStatus: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /persistent builder is unavailable/);
  assert.equal(result.output, "");
});

test("a managed job needs an absolute Buildx configuration path", linux, () => {
  for (const config of ["", "relative/path"]) {
    const result = select("default", { config });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /absolute BUILDX_CONFIG/);
    assert.equal(result.calls, "");
  }
});

test("a containerized builder cannot be selected on a managed job", linux, () => {
  const result = select("default", { driver: "docker-container" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Docker engine or its own BuildKit service/);
  assert.equal(result.output, "");
});

test("only GitHub-hosted jobs create a job-owned builder", () => {
  const hosted = action.split("    - name: BuildKit on GitHub-hosted runners\n")[1].split("\n    - name: ")[0];
  assert.match(managed, /if: runner\.environment == 'self-hosted'/);
  assert.match(hosted, /if: runner\.environment == 'github-hosted'/);
  assert.match(hosted, /uses: docker\/setup-buildx-action@/);
  assert.doesNotMatch(action, /NDDEV_BUILD_CACHE_ROOT|docker volume create|keep-state:/);
});
