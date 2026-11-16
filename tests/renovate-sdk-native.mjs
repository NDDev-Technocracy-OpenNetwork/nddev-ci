import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { copyFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 300000, maxBuffer: 8 * 1024 * 1024, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
};

test("the published preset and generated self block use native Renovate extraction and replacement", { timeout: 600000 }, () => {
  const name = `nddev-ci-sdk-${randomUUID()}`;
  const image = `${name}:test`;
  const dockerfile = readFileSync(path.join(root, "tests/fixtures/renovate/Dockerfile"), "utf8");
  const version = /^FROM \S+:([0-9]+\.[0-9]+\.[0-9]+)@sha256:[a-f0-9]{64}\s*$/m.exec(dockerfile)?.[1];
  assert.ok(version, "the native test image must have a version and immutable digest");
  const revision = run("git", ["rev-parse", "HEAD"], { cwd: root });
  const repository = process.env.GITHUB_REPOSITORY ?? "NDDev-Technocracy-OpenNetwork/nddev-ci";
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const preset = readFileSync(path.join(root, "renovate-sdk-inputs.json"));
  assert.equal(run("git", ["show", `${revision}:renovate-sdk-inputs.json`], { cwd: root }), preset.toString().trim(), "native qualification requires the committed preset");
  const temporary = mkdtempSync(path.join(tmpdir(), "renovate-sdk-native-"));
  const source = { repository, revision, version, presetSha256: createHash("sha256").update(preset).digest("hex") };
  try {
    for (const [from, to] of [
      ["renovate-sdk-inputs.json", "preset.json"],
      ["renovate.json", "self.json"],
      ["lib/renovate-sdk.mjs", "definition.mjs"],
      ["tests/fixtures/renovate/qualify.mjs", "qualify.mjs"],
    ]) {
      copyFileSync(path.join(root, from), path.join(temporary, to));
      chmodSync(path.join(temporary, to), 0o644);
    }
    writeFileSync(path.join(temporary, "source.json"), JSON.stringify(source));
    chmodSync(path.join(temporary, "source.json"), 0o644);
    run("docker", ["build", "--tag", image, path.join(root, "tests/fixtures/renovate")]);
    const mounts = ["preset.json", "self.json", "definition.mjs", "qualify.mjs", "source.json"].flatMap((file) => ["--mount", `type=bind,src=${path.join(temporary, file)},dst=/fixture/${file},readonly`]);
    // No host home, Docker socket or credential is mounted or forwarded to the engine.
    const output = run("docker", ["run", "--rm", "--name", name, "--read-only", "--user", "12021:12021", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--tmpfs", "/tmp:rw,size=32m,mode=1777", "--memory", "1g", "--cpus", "1", "--pids-limit", "128", ...mounts, "--entrypoint", "node", image, "--test", "/fixture/qualify.mjs"]);
    console.log(output);
  } finally {
    const failures = [];
    for (const [args, absent] of [[ ["rm", "--force", name], /No such container/ ], [ ["image", "rm", image], /No such image/ ]]) {
      const removed = spawnSync("docker", args, { encoding: "utf8", timeout: 30000 });
      if (removed.error || (removed.status !== 0 && !absent.test(removed.stderr))) {
        failures.push(removed.error?.message ?? removed.stderr);
      }
    }
    rmSync(temporary, { recursive: true, force: true });
    assert.deepEqual(failures, [], "owned qualification cleanup failed");
    console.log(JSON.stringify({ cleanup: "complete", container: name, image, fixtureDirectoryRemoved: true }));
  }
});
