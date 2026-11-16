import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { copyFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const qualifiedRuntime = {
  source: "955bc7e6f11f781172eafc8792993d6159eaed10",
  image: "ghcr.io/rldyourmnd/renovate@sha256:8854037d7bc43f12f607e659f7fe1797253a7a07e257b2eaa3f9a3ce22f73b49",
  version: "44.236.4-nddev.1",
  configDigest: "sha256:6f181385c10e52bcbd67f77676c52a54408b70fed05ce60aa37020377331668d",
};

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 300000, maxBuffer: 8 * 1024 * 1024, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
};

test("the published strict SDK preset and generated self block use the qualified native runtime", { timeout: 900000 }, async () => {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "native Docker qualification uses the declared hosted provider");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.ok(process.env.GH_TOKEN, "the hosted job read token is required");
  const name = `nddev-ci-sdk-${randomUUID()}`;
  const image = `${name}:test`;
  const fixtureDirectory = path.join(root, "tests/fixtures/renovate");
  const expected = qualifiedRuntime;
  const revision = run("git", ["rev-parse", "HEAD"], { cwd: root });
  const repository = process.env.GITHUB_REPOSITORY;
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const preset = readFileSync(path.join(root, "renovate-sdk-inputs.json"));
  assert.equal(run("git", ["show", `${revision}:renovate-sdk-inputs.json`], { cwd: root }), preset.toString().trim(), "native qualification requires the committed preset");
  const temporary = mkdtempSync(path.join(tmpdir(), "renovate-sdk-native-"));
  try {
    run("skopeo", ["copy", `docker://${expected.image}`, `docker-daemon:${image}`]);
    assert.equal(run("docker", ["image", "inspect", "--format", "{{.Id}}", image]), expected.configDigest, "native qualification must run the exact published image");
    assert.equal(run("docker", ["image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]), expected.source);
    for (const [from, to] of [
      ["renovate-sdk-inputs.json", "preset.json"],
      ["renovate.json", "self.json"],
      ["lib/renovate-sdk.mjs", "definition.mjs"],
      ["tests/fixtures/renovate/qualify.mjs", "qualify.mjs"],
    ]) {
      copyFileSync(path.join(root, from), path.join(temporary, to));
      chmodSync(path.join(temporary, to), 0o644);
    }
    const source = { repository, revision, version: expected.version, presetSha256: createHash("sha256").update(preset).digest("hex") };
    writeFileSync(path.join(temporary, "source.json"), JSON.stringify(source));
    chmodSync(path.join(temporary, "source.json"), 0o644);
    const mounts = ["preset.json", "self.json", "definition.mjs", "qualify.mjs", "source.json"].flatMap((file) => ["--mount", `type=bind,src=${path.join(temporary, file)},dst=/fixture/${file},readonly`]);
    // Only the hosted job's short-lived public-read token enters the bounded container.
    const output = run("docker", ["run", "--rm", "--name", name, "--read-only", "--user", "12021:12021", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--tmpfs", "/tmp:rw,size=32m,mode=1777", "--memory", "1g", "--cpus", "1", "--pids-limit", "128", "--env", "GITHUB_TOKEN", ...mounts, "--entrypoint", "node", image, "--test", "/fixture/qualify.mjs"], { env: { ...process.env, GITHUB_TOKEN: process.env.GH_TOKEN } });
    const warning = "Unable to parse YAML with aliases disabled; skipping custom JSONata extraction";
    assert.ok(output.split(warning).length - 1 >= 6, "native alias refusal must report skipped files");
    assert.ok(output.includes(".github/workflows/ci.yml"));
    console.log(output);
    console.log(JSON.stringify({ runtime: expected, preset: source, transport: "published immutable OCI image" }));
  } finally {
    const failures = [];
    for (const [args, absent] of [
      [["rm", "--force", name], /No such container/],
      [["image", "rm", image], /No such image/],
    ]) {
      const removed = spawnSync("docker", args, { encoding: "utf8", timeout: 30000 });
      if (removed.error || (removed.status !== 0 && !absent.test(removed.stderr))) failures.push(removed.error?.message ?? removed.stderr);
    }
    rmSync(temporary, { recursive: true, force: true });
    assert.deepEqual(failures, [], "owned qualification cleanup failed");
    console.log(JSON.stringify({ cleanup: "complete", container: name, image, fixtureDirectoryRemoved: true }));
  }
});
