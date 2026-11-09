import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { childEnvironment, configuration, directory, main, selections } from "../actions/renovate/run.mjs";

const base = {RUNNER_ENVIRONMENT: "self-hosted", GITHUB_REPOSITORY_OWNER: "example", GITHUB_API_URL: "https://api.github.com",
  INPUT_VERSION: "44.221.5", INPUT_REPOSITORIES: "example/first\nexample/second"};

test("Renovate takes an exact managed selection and explicit same-organization scope", () => {
  assert.deepEqual(selections(base), {version: "44.221.5", repositories: ["example/first", "example/second"], timeout: 45, dryRun: false});
  for (const version of ["latest", "44.x", "v44.221.5", "01.2.3", "44.221.5-rc1"])
    assert.throws(() => selections({...base, INPUT_VERSION: version}));
  for (const repositories of ["", "other/project", "example/first example/FIRST", "example/first;command"])
    assert.throws(() => selections({...base, INPUT_REPOSITORIES: repositories}));
  assert.throws(() => selections({...base, RUNNER_ENVIRONMENT: "github-hosted"}));
  assert.throws(() => selections({...base, "INPUT_TIMEOUT-MINUTES": "60"}));
});

test("Renovate uses prepared binaries and cannot enable repository scripts or automerge", () => {
  const config = configuration(base, selections(base), "/owned/workspace");
  assert.equal(config.binarySource, "global");
  assert.equal(config.allowScripts, false); assert.equal(config.allowPlugins, false);
  assert.deepEqual(config.allowedCommands, []); assert.equal(config.exposeAllEnv, false);
  assert.equal(config.force.automerge, false); assert.equal(config.requireConfig, "required");
  assert.equal(config.dryRun, undefined);
  const dry = {...base, "INPUT_DRY-RUN": "true", "INPUT_DOCKERHUB-USERNAME": "read-user", "INPUT_DOCKERHUB-TOKEN": "fixture-read-token"};
  const configured = configuration(dry, selections(dry), "/owned/workspace");
  assert.equal(configured.dryRun, "full");
  assert.deepEqual(configured.hostRules, [{hostType: "docker", matchHost: "docker.io", username: "read-user", password: "fixture-read-token"}]);
  assert.throws(() => configuration({...base, "INPUT_DOCKERHUB-TOKEN": "fixture"}, selections(base), "/owned/workspace"));
});

test("ambient and action credentials do not enter the version probe or override managed configuration", () => {
  assert.deepEqual(childEnvironment({PATH: "/managed/bin", DO_NOT_TRACK: "1", "INPUT_GITHUB-TOKEN": "fixture-token",
    GITHUB_TOKEN: "other-token", GH_TOKEN: "other-token", RENOVATE_ALLOW_SCRIPTS: "true", NODE_OPTIONS: "--require unsafe",
    GIT_CONFIG_COUNT: "1", SSH_AUTH_SOCK: "/credential-agent"}), {PATH: "/managed/bin", DO_NOT_TRACK: "1"});
});

test("owned Renovate cleanup is safe to repeat and refuses unrelated or linked directories", () => {
  const root = mkdtempSync(path.join(tmpdir(), "renovate-cleanup-"));
  const workspace = mkdtempSync(path.join(root, "nddev-renovate-"));
  const outside = mkdtempSync(path.join(tmpdir(), "renovate-unrelated-"));
  try {
    writeFileSync(path.join(workspace, "token-placeholder"), "fixture credential");
    assert.equal(directory({RUNNER_TEMP: root}, workspace), workspace);
    assert.throws(() => directory({RUNNER_TEMP: root}, outside));
    const linked = path.join(root, "nddev-renovate-linked");
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => directory({RUNNER_TEMP: root}, linked));
    main({RUNNER_TEMP: root, INPUT_MODE: "cleanup", INPUT_DIRECTORY: workspace});
    main({RUNNER_TEMP: root, INPUT_MODE: "cleanup", INPUT_DIRECTORY: workspace});
    assert.equal(existsSync(workspace), false); assert.equal(existsSync(outside), true);
  } finally { rmSync(root, {recursive: true, force: true}); rmSync(outside, {recursive: true, force: true}); }
});
