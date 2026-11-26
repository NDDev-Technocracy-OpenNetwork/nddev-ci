import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {runInNewContext} from "node:vm";
import {admit, buildCache, initialize, requireStore} from "../lib/images.mjs";

const plan = () => ({schema: 1, output: "dist/images", images: [
  {name: "application", dockerfile: "Dockerfile", context: ".", platform: "linux/amd64", public_build_args: {}},
]});
test("one complete image plan accepts literal public inputs, never arbitrary build operations", () => {
  const value = plan();
  value.images[0].public_build_args.PUBLIC_LABEL = "$(touch marker); literal value";
  assert.equal(admit(value), value);
  for (const change of [
    (p) => p.images.push({...p.images[0]}),
    (p) => p.images[0].flags = ["--push"],
    (p) => p.images[0].platform = "linux/amd64,linux/arm64",
    (p) => p.images[0].context = "../outside",
    (p) => p.output = "/outside",
    (p) => p.images[0].public_build_args.PUBLIC_LABEL = "first\nINJECTED=value",
    (p) => p.images[0].public_build_config_digest = "sha256:wrong",
    (p) => p.images = [],
  ]) {
    const invalid = plan(); change(invalid);
    assert.throws(() => admit(invalid));
  }
});
test("prepared state replays only within its exact job and refuses linked state directories", () => {
  const root = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "image-state-"));
  try {
    const workspace = path.join(root, "workspace"), temp = path.join(root, "temp");
    mkdirSync(workspace); mkdirSync(temp);
    const env = {RUNNER_TEMP: temp, GITHUB_WORKSPACE: workspace, GITHUB_REPOSITORY: "example/fixture",
      GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "258", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "image",
      IMAGE_BUILD_NETWORK: "host", IMAGE_BUILD_ARGUMENTS: "NPM_CONFIG_REGISTRY=http://127.0.0.1:1234/npm/"};
    const first = initialize(env);
    assert.equal(initialize(env), first);
    assert.match(first, /NDDEV_CI_IMAGE_OWNER=[a-f0-9-]{36}/);
    assert.match(first, /--network","host","--allow","network.host"/);
    for (const change of [{GITHUB_RUN_ATTEMPT: "2"}, {GITHUB_SHA: "b".repeat(40)}, {GITHUB_JOB: "other"}, {DOCKER_HOST: "unix:///unrelated.sock"}])
      assert.throws(() => initialize({...env, ...change}), /another job/);
    assert.throws(() => initialize({...env, IMAGE_BUILD_NETWORK: "external"}), /network/);
    rmSync(path.join(temp, "nddev-ci"), {recursive: true});
    symlinkSync(workspace, path.join(temp, "nddev-ci"));
    assert.throws(() => initialize(env), /symlink/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
test("completion always cleans the fixed library entry after upload and records cleanup failure as library failure", () => {
  const source = readFileSync(new URL("../actions/complete/action.yml", import.meta.url), "utf8");
  assert.ok(source.indexOf("id: artifact") < source.indexOf("id: images-cleanup"));
  assert.match(source, /id: images-cleanup\n\s+if: always\(\)/);
  assert.match(source, /IMAGE_PRODUCER_ENTRY: .+github.action_path.+\/\.\.\/\.\.\/lib\/images.mjs/);
  const expression = (key) => source.split("\n").find((line) => line.trimStart().startsWith(key + ": $")).
    split(": $")[1].slice(2, -3).replace(/steps\.([a-z]+-[a-z-]+)/g, 'steps["$1"]').
    replace(/inputs\.project-outcome/g, 'inputs["project-outcome"]');
  const evaluate = (key, overrides = {}) => runInNewContext(expression(key), {
    inputs: {status: "success", "project-outcome": "success"},
    steps: {artifact: {outcome: "success"}, "artifact-oci": {outcome: "success"}, reports: {outcome: "success"},
      "reports-kept": {outcome: "success"}, "images-cleanup": {outcome: "success"}, ...overrides},
  });
  assert.equal(evaluate("status"), "success");
  assert.equal(evaluate("status", {"images-cleanup": {outcome: "failure"}}), "failure");
  assert.equal(evaluate("failure-layer", {"images-cleanup": {outcome: "failure"}}), "library");
  assert.equal(evaluate("status", {"artifact-oci": {outcome: "failure"}}), "failure");
  assert.equal(evaluate("failure-layer", {"artifact-oci": {outcome: "failure"}}), "library");
});

test("only the declared containerd store satisfies image production", () => {
  assert.doesNotThrow(() => requireStore([["driver-type", "io.containerd.snapshotter.v1"]]));
  for (const info of [[], [["Backing Filesystem", "extfs"]], null, {driver: "containerd"}])
    assert.throws(() => requireStore(info), /execution profile/);
});

test("shared manifests follow the repository, image, platform, target and ref across runners", () => {
  assert.equal(buildCache(plan().images[0], {}), null);
  const root = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "image-cache-"));
  try {
    const event = path.join(root, "event.json");
    writeFileSync(event, JSON.stringify({repository: {id: 42, default_branch: "main"}}));
    const env = {
      NDDEV_BUILDKIT_CACHE_ENDPOINT: "http://127.0.0.1:8750",
      NDDEV_BUILDKIT_CACHE_BUCKET: "ci-cache",
      GITHUB_REPOSITORY_ID: "42",
      GITHUB_REF: "refs/pull/9/merge",
      GITHUB_EVENT_PATH: event,
    };
    const image = plan().images[0];
    const {from, to} = buildCache(image, env);
    const {GITHUB_REPOSITORY_ID: _omitted, ...envWithoutRepoId} = env;
    assert.deepEqual(buildCache(image, envWithoutRepoId), {from, to});
    assert.equal(from.length, 2);
    assert.equal(
      to,
      from[0] + ",mode=max,compression=zstd,compression-level=3,force-compression=true,touch_refresh=72h,ignore-error=true",
    );
    assert.match(from[0], /^type=s3,region=auto,use_path_style=true,prefix=buildkit\//);
    assert.equal(buildCache(image, {...env, RUNNER_NAME: "another-slot"}).to, to);
    assert.deepEqual(buildCache(image, {...env, GITHUB_REF: "refs/heads/main"}).from, [from[1]]);
    for (const variant of [{name: "another"}, {platform: "linux/arm64"}, {target: "dev"}])
      assert.notEqual(buildCache({...image, ...variant}, env).to, to);
    assert.notEqual(buildCache(image, {...env, GITHUB_REPOSITORY_ID: "43"}).to, to);
    const missingIdEvent = path.join(root, "missing-id.json");
    writeFileSync(missingIdEvent, JSON.stringify({repository: {default_branch: "main"}}));
    assert.throws(
      () => buildCache(image, {...envWithoutRepoId, GITHUB_EVENT_PATH: missingIdEvent}),
      /repository ID/,
    );
    assert.throws(() => buildCache(image, {...env, NDDEV_BUILDKIT_CACHE_ENDPOINT: "http://other:8750,"}), /loopback/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("image workflow exports zstd OCI archive for trace checks and pushes zstd OCI layers", () => {
  const source = readFileSync(new URL("../.github/workflows/image.yml", import.meta.url), "utf8");
  const outputsLine = source.match(/outputs: >-\n\s+\$\{\{ (.+) \}\}/)?.[1];
  assert.ok(outputsLine, "image.yml outputs expression exists");
  const evaluate = (github, inputs, runner) => runInNewContext(outputsLine, {github, inputs, runner});
  const zstdRegistry = "type=registry,oci-mediatypes=true,compression=zstd,compression-level=3,force-compression=true";
  assert.equal(evaluate({event_name: "push"}, {push: true}, {environment: "self-hosted"}), zstdRegistry);
  assert.equal(evaluate({event_name: "push"}, {push: true}, {environment: "github-hosted"}), zstdRegistry);
  assert.equal(evaluate({event_name: "pull_request"}, {push: true}, {environment: "self-hosted"}), "type=cacheonly");
  assert.equal(evaluate({event_name: "push"}, {push: false}, {environment: "self-hosted"}), "type=cacheonly");
  assert.equal(evaluate({event_name: "pull_request"}, {push: true}, {environment: "github-hosted"}), "");
  assert.match(source, /type=oci,dest=\$\{RUNNER_TEMP\}\/nddev-ci-image\.oci\.tar,compression=zstd,compression-level=3,force-compression=true/);
  assert.match(source, /uses: \$\/actions\/artifact-traces/);
  assert.match(source, /type=gha,mode=max,compression=zstd,compression-level=3,force-compression=true,scope=image-\{0\}/);
});
