import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// The image builder's state step, run as the runner runs it, with a docker that only records its
// arguments.
const action = readFileSync(new URL("../actions/image-builder/action.yml", import.meta.url), "utf8");
const block = action.split("    - name: Builder state of a trusted managed job\n")[1].split("\n    - name: ")[0];
const image = block.match(/BUILDKIT_IMAGE: (\S+)/)[1];
const version = image.split(":")[1].split("@")[0];
// Image builds run on Linux runners only, so the step is exercised where it runs.
const linux = {skip: process.platform === "linux" ? false : "image builds are Linux-only"};
const script = block.split("      run: |\n")[1].split("\n").map((line) => line.replace(/^ {8}/, "")).join("\n");

function run(environment, prepare = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), "image-builder-state-"));
  try {
    const bin = path.join(root, "bin"), cache = path.join(root, "cache");
    mkdirSync(bin);
    mkdirSync(cache);
    writeFileSync(path.join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${root}/docker"\n`);
    chmodSync(path.join(bin, "docker"), 0o755);
    writeFileSync(path.join(root, "output"), "");
    prepare(cache);
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: {PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: path.join(root, "output"), BUILDKIT_IMAGE: image,
        RUNNER_ENVIRONMENT: "self-hosted", NDDEV_CACHE_TRUST: "trusted", NDDEV_BUILD_CACHE_ROOT: cache, ...environment(cache)},
    });
    const read = (name) => existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), "utf8") : "";
    const state = path.join(cache, "nddev-ci", "buildkit");
    const entries = existsSync(state) ? readdirSync(state, {recursive: true}) : [];
    return {status: result.status, stdout: result.stdout, stderr: result.stderr, docker: read("docker"), output: read("output"),
      kept: (name) => entries.includes(name)};
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

test("a trusted managed job binds the builder's state into the slot's build cache", linux, () => {
  const result = run(() => ({}));
  assert.equal(result.status, 0, result.stderr);
  const args = result.docker.trim().split("\n");
  assert.deepEqual(args.slice(0, 2), ["volume", "create"]);
  assert.equal(args.at(-1), "buildx_buildkit_nddev-ci-images0_state");
  assert.ok(args.includes("o=bind") && args.includes("type=none"));
  assert.match(args.find((arg) => arg.startsWith("device=")), new RegExp(`/cache/nddev-ci/buildkit/${version.replaceAll(".", "\\.")}$`));
  assert.match(result.output, /^name=nddev-ci-images$/m);
  assert.ok(result.output.startsWith(`image=${image}\n`));
  assert.match(result.output, /maxUsedSpace = "40%"/);
  assert.ok(result.kept(version));
});

test("a pull request, a hosted runner or a missing root starts BuildKit empty", linux, () => {
  for (const environment of [
    () => ({NDDEV_CACHE_TRUST: "untrusted"}),
    () => ({NDDEV_CACHE_TRUST: ""}),
    () => ({RUNNER_ENVIRONMENT: "github-hosted"}),
    () => ({NDDEV_BUILD_CACHE_ROOT: ""}),
    () => ({NDDEV_BUILD_CACHE_ROOT: "relative/cache"}),
    (cache) => ({NDDEV_BUILD_CACHE_ROOT: path.join(cache, "absent")}),
  ]) {
    const result = run(environment);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.docker, "");
    assert.equal(result.output, `image=${image}\n`);
    assert.match(result.stdout, /starts empty/);
  }
});

test("the state of this BuildKit release stays, and another release's state leaves", linux, () => {
  const layer = (cache, name) => {
    mkdirSync(path.join(cache, "nddev-ci", "buildkit", name), {recursive: true});
    writeFileSync(path.join(cache, "nddev-ci", "buildkit", name, "layer"), "kept");
  };
  const same = run(() => ({}), (cache) => layer(cache, version));
  assert.equal(same.status, 0, same.stderr);
  assert.ok(same.kept(path.join(version, "layer")));
  const other = run(() => ({}), (cache) => layer(cache, "v0.1.0"));
  assert.equal(other.status, 0, other.stderr);
  assert.ok(!other.kept("v0.1.0"));
  assert.ok(other.kept(version));
});
