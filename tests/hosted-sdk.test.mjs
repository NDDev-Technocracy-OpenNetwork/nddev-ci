import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cachePlan, imageKey, main, selections, supported, verify } from "../actions/hosted-sdk/run.mjs";
import { selectRelease } from "../actions/hosted-sdk/flutter.mjs";

const hosted = {SDK_RUNNER_ENVIRONMENT: "github-hosted"};

test("only exact caller versions can select SDK downloads", () => {
  assert.deepEqual(selections(hosted), {});
  for (const value of ["stable", "latest", "26.x", "1.99", "3.15.2-dev", "1.0.0\n", " 1.0.0", "01.0.0", "$(command)"])
    assert.throws(() => selections({...hosted, SDK_NODE_VERSION: value}));
  assert.deepEqual(selections({...hosted, SDK_PYTHON_VERSION: "3.14.10", SDK_NODE_VERSION: "26.13.0"}), {node: "26.13.0", python: "3.14.10"});
  assert.throws(() => selections({...hosted, SDK_RUST_COMPONENTS: "clippy"}));
  assert.throws(() => selections({...hosted, SDK_RUST_VERSION: "1.99.1", SDK_RUST_TARGETS: "--profile minimal"}));
  assert.deepEqual(selections({...hosted, SDK_RUST_VERSION: "1.99.1", SDK_RUST_COMPONENTS: "clippy,rustfmt", SDK_RUST_TARGETS: "aarch64-apple-darwin"}), {rust: "1.99.1"});
});

test("managed private environments refuse hosted SDK installation", () => {
  for (const kind of ["self-hosted", "", undefined])
    assert.throws(() => selections({SDK_RUNNER_ENVIRONMENT: kind, SDK_NODE_VERSION: "26.13.0"}));
});

test("the actual executable is measured and a mismatched version refuses a receipt", () => {
  const environment = {...process.env, ...hosted, SDK_NODE_VERSION: process.versions.node};
  const receipt = verify(environment);
  assert.deepEqual(receipt.versions, {node: process.versions.node});
  assert.equal(receipt.platform, process.platform);
  assert.equal(receipt.architecture, process.arch);
  assert.throws(() => verify({...environment, SDK_NODE_VERSION: "0.0.0"}));
  assert.throws(() => verify({...environment, PATH: ""}));
});

test("the action exposes measured versions and persistent opt-out without installing another SDK", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hosted-sdk-"));
  try {
    const environment = {...process.env, ...hosted, SDK_NODE_VERSION: process.versions.node,
      GITHUB_ENV: path.join(root, "environment"), GITHUB_OUTPUT: path.join(root, "output")};
    main("verify", environment);
    const output = readFileSync(environment.GITHUB_OUTPUT, "utf8");
    const receipt = JSON.parse(output.trim().slice("receipt=".length));
    assert.deepEqual(receipt.versions, {node: process.versions.node});
    const variables = readFileSync(environment.GITHUB_ENV, "utf8");
    assert.match(variables, /^BUN_DO_NOT_TRACK=1$/m);
    assert.match(variables, /^DO_NOT_TRACK=1$/m);
    assert.doesNotMatch(variables, /UV_/);
    assert.throws(() => main("unknown", environment));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("Java, Go and Flutter take exact versions like the other SDKs", () => {
  assert.deepEqual(
    selections({...hosted, SDK_JAVA_VERSION: "25.0.5", SDK_GO_VERSION: "1.27.3", SDK_FLUTTER_VERSION: "3.44.1"}),
    {java: "25.0.5", go: "1.27.3", flutter: "3.44.1"});
  for (const value of ["25", "stable", "1.27.x", "3.44.1-pre"])
    assert.throws(() => selections({...hosted, SDK_GO_VERSION: value}), value);
});

test("the tool cache entry names the image, architecture and every exact cached SDK", () => {
  const base = {...hosted, RUNNER_TOOL_CACHE: path.join("cache", "tools"), ImageOS: "ubuntu24", RUNNER_ARCH: "ARM64"};
  assert.deepEqual(cachePlan({...base, SDK_RUST_VERSION: "1.99.1"}), {key: "", paths: []});
  const plan = cachePlan({...base, SDK_NODE_VERSION: "26.13.0", SDK_PYTHON_VERSION: "3.15.2",
    SDK_UV_VERSION: "0.13.7", SDK_BUN_VERSION: "1.4.4"});
  assert.equal(plan.key, "nddev-sdk-v1-ubuntu24-ARM64-node-26.13.0-python-3.15.2-uv-0.13.7");
  assert.deepEqual(plan.paths, [
    path.join("cache", "tools", "node", "26.13.0"),
    path.join("cache", "tools", "Python", "3.15.2"),
    path.join("cache", "tools", "uv", "0.13.7"),
  ]);
  assert.throws(() => cachePlan({...base, RUNNER_TOOL_CACHE: "", SDK_NODE_VERSION: "26.13.0"}));
});

test("validation writes the cache plan as step outputs", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hosted-sdk-plan-"));
  try {
    const environment = {...hosted, RUNNER_TOOL_CACHE: root, ImageOS: "macos15", RUNNER_ARCH: "ARM64",
      SDK_PYTHON_VERSION: "3.15.2", GITHUB_OUTPUT: path.join(root, "output")};
    main("validate", environment);
    const output = readFileSync(environment.GITHUB_OUTPUT, "utf8");
    assert.match(output, /^cache-key=nddev-sdk-v1-macos15-ARM64-python-3\.15\.2$/m);
    assert.ok(output.includes(`cache-paths<<NDDEV_SDK_PATHS\n${path.join(root, "Python", "3.15.2")}\nNDDEV_SDK_PATHS\n`));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("Flutter is selected only where it publishes an SDK", () => {
  supported({flutter: "3.47.9"}, "linux", "x64");
  supported({flutter: "3.47.9"}, "win32", "x64");
  supported({flutter: "3.47.9"}, "darwin", "arm64");
  supported({node: "26.13.0"}, "linux", "arm64");
  assert.throws(() => supported({flutter: "3.47.9"}, "linux", "arm64"), /x64 runner/);
  assert.throws(() => supported({flutter: "3.47.9"}, "win32", "arm64"), /x64 runner/);
});

test("Flutter comes from one stable entry of the official manifest with its digest", () => {
  const origin = "https://storage.googleapis.com/flutter_infra_release/releases";
  const entry = (fields) => ({channel: "stable", version: "3.47.9", dart_sdk_version: "3.13.7",
    archive: "stable/macos/flutter_macos_arm64_3.47.9-stable.zip", sha256: "6".repeat(64), dart_sdk_arch: "arm64", ...fields});
  const document = {base_url: origin, releases: [
    entry({}), entry({dart_sdk_arch: "x64", archive: "stable/macos/flutter_macos_3.47.9-stable.zip", sha256: "0".repeat(64)}),
    entry({channel: "beta"}), entry({version: "3.47.8"})]};
  assert.deepEqual(selectRelease(document, "3.47.9", "darwin", "arm64"), {
    url: `${origin}/stable/macos/flutter_macos_arm64_3.47.9-stable.zip`, sha256: "6".repeat(64),
    archive: "stable/macos/flutter_macos_arm64_3.47.9-stable.zip", dart: "3.13.7"});
  assert.equal(selectRelease(document, "3.47.9", "darwin", "x64").sha256, "0".repeat(64));
  assert.throws(() => selectRelease(document, "3.47.10", "darwin", "arm64"), /no single stable/);
  assert.throws(() => selectRelease({...document, base_url: "https://example.com"}, "3.47.9", "darwin", "arm64"), /origin/);
  assert.throws(() => selectRelease({base_url: origin, releases: [entry({archive: "../x.zip"})]}, "3.47.9", "darwin", "arm64"), /plain archive/);
  assert.throws(() => selectRelease({base_url: origin, releases: [entry({}), entry({})]}, "3.47.9", "darwin", "arm64"), /no single/);
  assert.throws(() => selectRelease(document, "3.47.9", "freebsd", "x64"), /no SDK/);
});

test("the image key comes from ImageOS or from the system's own release", () => {
  assert.equal(imageKey({ImageOS: "ubuntu24"}), "ubuntu24");
  const linux = () => 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n';
  assert.equal(imageKey({}, "linux", linux), "ubuntu2404");
  assert.equal(imageKey({ImageOS: "Ubuntu 24"}, "linux", linux), "ubuntu2404");
  assert.equal(imageKey({}, "darwin", linux, "25.1.0"), "darwin25");
  assert.equal(imageKey({}, "win32", linux, "10.0.26100"), "win26100");
  assert.throws(() => imageKey({}, "linux", () => "NAME=x\n"), /image is unknown/);
  assert.throws(() => imageKey({}, "freebsd", linux, "14.1"), /image is unknown/);
});
