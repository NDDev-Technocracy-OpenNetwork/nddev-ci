import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { cachePlan, imageKey, javaVersion, main, managedPython, managedTools, selections, supported, verify } from "../actions/hosted-sdk/run.mjs";
import { selectRelease } from "../actions/hosted-sdk/flutter.mjs";
import { dartArchive, dartDigest } from "../actions/hosted-sdk/dart.mjs";
import { parseAndroidPackage, parseAndroidSdkSpec, writeAndroidLicenses } from "../actions/hosted-sdk/android.mjs";

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

test("standalone Dart selects the official exact archive and its checksum", () => {
  const {filename, url} = dartArchive("3.13.5", "linux", "x64");
  assert.equal(filename, "dartsdk-linux-x64-release.zip");
  assert.equal(url, "https://storage.googleapis.com/dart-archive/channels/stable/release/3.13.5/sdk/" + filename);
  assert.equal(dartArchive("3.13.5", "win32", "arm64").filename, "dartsdk-windows-arm64-release.zip");
  assert.throws(() => dartArchive("stable", "linux", "x64"));
  assert.throws(() => dartArchive("3.13.5", "linux", "ia32"));
  const hash = "ea864bc64df30a6b8bdf30b2e32550f7717d9a890de8f40293aeabb924fe232b";
  const checksum = `${hash} *${filename}\n`;
  assert.equal(dartDigest(checksum, filename), hash);
  assert.throws(() => dartDigest(checksum, "dartsdk-linux-arm64-release.zip"));
  assert.throws(() => dartDigest(checksum.repeat(2), filename));
  assert.deepEqual(selections({...hosted, SDK_DART_VERSION: "3.13.5"}), {dart: "3.13.5"});
});

test("managed Dart verifies the selected stable executable", {skip: process.platform === "win32"}, () => {
  const root = mkdtempSync(path.join(tmpdir(), "managed-dart-sdk-"));
  try {
    const dart = path.join(root, "dart");
    writeFileSync(dart, "#!/bin/sh\nprintf 'Dart SDK version: 3.13.5 (stable) on linux_x64\\n' >&2\n", {mode: 0o755});
    const managed = {SDK_RUNNER_ENVIRONMENT: "self-hosted", PATH: root, SDK_DART_VERSION: "3.13.5"};
    assert.deepEqual(verify(managed).versions, {dart: "3.13.5"});
    assert.throws(() => verify({...managed, SDK_DART_VERSION: "3.13.4"}));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("managed private environments have no hosted download cache", () => {
  const managed = {SDK_RUNNER_ENVIRONMENT: "self-hosted", SDK_NODE_VERSION: process.versions.node};
  assert.deepEqual(cachePlan(managed), {key: "", paths: []});
  for (const kind of ["", undefined])
    assert.throws(() => selections({SDK_RUNNER_ENVIRONMENT: kind, SDK_NODE_VERSION: "26.13.0"}));
});

test("managed Node selects and verifies only the exact native tool-cache entry", {skip: process.platform === "win32"}, () => {
  const root = mkdtempSync(path.join(tmpdir(), "managed-node-sdk-"));
  try {
    const cache = path.join(root, "prepared SDK");
    const requested = process.versions.node;
    const nativeBin = (version, arch = process.arch) => {
      const bin = path.join(cache, "node", version, arch, "bin");
      mkdirSync(bin, {recursive: true});
      return bin;
    };
    const alternate = "0.0.0";
    const defaultBin = nativeBin(alternate);
    const defaultNode = path.join(defaultBin, "node");
    writeFileSync(defaultNode, "#!/bin/sh\nprintf 'v0.0.0\\n'\n", {mode: 0o755});
    const selectedBin = nativeBin(requested);
    const selectedNode = path.join(selectedBin, "node");
    copyFileSync(process.execPath, selectedNode);
    chmodSync(selectedNode, 0o755);

    const managed = {SDK_RUNNER_ENVIRONMENT: "self-hosted", RUNNER_TOOL_CACHE: cache,
      PATH: defaultBin, SDK_NODE_VERSION: requested, GITHUB_PATH: path.join(root, "path"),
      GITHUB_OUTPUT: path.join(root, "output")};
    const readReceipt = (file) => JSON.parse(readFileSync(file, "utf8").trim().slice("receipt=".length));

    main("verify", managed);
    assert.deepEqual(readReceipt(managed.GITHUB_OUTPUT).versions, {node: requested});
    assert.equal(readFileSync(managed.GITHUB_PATH, "utf8"), selectedBin + "\n");
    assert.deepEqual(verify({...managed, SDK_NODE_VERSION: alternate}).versions, {node: alternate});

    const untouched = {...managed, SDK_NODE_VERSION: "", GITHUB_PATH: path.join(root, "default-path"),
      GITHUB_OUTPUT: path.join(root, "default-output")};
    main("verify", untouched);
    assert.deepEqual(readReceipt(untouched.GITHUB_OUTPUT).versions, {});
    assert.equal(existsSync(untouched.GITHUB_PATH), false);

    const otherArchitecture = process.arch === "arm64" ? "x64" : "arm64";
    const wrongArchBin = nativeBin(requested, otherArchitecture);
    renameSync(selectedNode, path.join(wrongArchBin, "node"));
    const refusal = {...managed, PATH: wrongArchBin, GITHUB_PATH: path.join(root, "refused-path"),
      GITHUB_OUTPUT: path.join(root, "refused-output")};
    assert.throws(() => main("verify", refusal), /selected node executable/);
    copyFileSync(defaultNode, selectedNode);
    assert.throws(() => main("verify", refusal), /selected node executable/);
    assert.equal(existsSync(refusal.GITHUB_PATH), false);
    assert.equal(existsSync(refusal.GITHUB_OUTPUT), false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("an explicitly selected external provider can prepare SDKs despite self-hosted classification", () => {
  const environment = {SDK_RUNNER_ENVIRONMENT: "self-hosted", SDK_MANAGED: "false", SDK_NODE_VERSION: "26.13.0",
    RUNNER_TOOL_CACHE: path.join("cache", "tools"), ImageOS: "ubuntu24", RUNNER_ARCH: "X64"};
  const plan = cachePlan(environment);
  assert.equal(plan.key, "nddev-sdk-v1-ubuntu24-X64-node-26.13.0");
  assert.deepEqual(plan.paths, [path.join("cache", "tools", "node", "26.13.0")]);
  assert.deepEqual(cachePlan({...environment, SDK_MANAGED: "true"}), {key: "", paths: []});
  assert.throws(() => selections({...environment, SDK_MANAGED: "yes"}));
});

test("declared tools are measured before the project runs", () => {
  const environment = {...process.env, ...hosted, SDK_TOOLS: `node@${process.versions.node}`};
  assert.deepEqual(verify(environment).tools, {node: process.versions.node});
  assert.throws(() => verify({...environment, SDK_TOOLS: "node@0.0.0"}), /selected node/);
  assert.throws(() => verify({...environment, SDK_TOOLS: "missing-ci-tool@1.0.0"}), /selected missing-ci-tool/);
});

test("a managed runner puts the declared line of a tool first when two lines stand side by side", {skip: process.platform === "win32"}, () => {
  const root = mkdtempSync(path.join(tmpdir(), "managed-tools-sdk-"));
  try {
    const cache = path.join(root, "prepared SDK");
    const tool = (version) => {
      const folder = path.join(cache, "fixture-ci-tool", version, process.arch);
      mkdirSync(folder, {recursive: true});
      writeFileSync(path.join(folder, "fixture-ci-tool"), `#!/bin/sh\nprintf 'fixture-ci-tool ${version}\\n'\n`, {mode: 0o755});
      return folder;
    };
    const older = tool("1.0.0");
    const newer = tool("1.1.0");
    const managed = {SDK_RUNNER_ENVIRONMENT: "self-hosted", RUNNER_TOOL_CACHE: cache,
      PATH: `${older}:${process.env.PATH}`, GITHUB_PATH: path.join(root, "path"),
      GITHUB_OUTPUT: path.join(root, "output")};
    assert.deepEqual(managedTools({...managed, SDK_TOOLS: "fixture-ci-tool@1.1.0"}), [newer]);
    assert.deepEqual(verify({...managed, SDK_TOOLS: "fixture-ci-tool@1.1.0"}).tools, {"fixture-ci-tool": "1.1.0"});
    assert.deepEqual(verify({...managed, SDK_TOOLS: "fixture-ci-tool@1.0.0"}).tools, {"fixture-ci-tool": "1.0.0"});
    main("verify", {...managed, SDK_TOOLS: "fixture-ci-tool@1.1.0"});
    assert.equal(readFileSync(managed.GITHUB_PATH, "utf8"), newer + "\n");
    assert.deepEqual(managedTools({...managed, SDK_TOOLS: "fixture-ci-tool@2.0.0"}), []);
    assert.throws(() => verify({...managed, SDK_TOOLS: "fixture-ci-tool@2.0.0"}), /selected fixture-ci-tool/);
    assert.deepEqual(managedTools({...managed, ...hosted, SDK_TOOLS: "fixture-ci-tool@1.1.0"}), []);
    assert.throws(() => managedTools({...managed, RUNNER_TOOL_CACHE: "relative", SDK_TOOLS: "fixture-ci-tool@1.1.0"}), /RUNNER_TOOL_CACHE/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("a managed runner selects the declared Bun line when two lines stand side by side", {skip: process.platform === "win32"}, () => {
  const root = mkdtempSync(path.join(tmpdir(), "managed-bun-sdk-"));
  try {
    const cache = path.join(root, "prepared SDK");
    const bunFolder = (version) => {
      const folder = path.join(cache, "bun", version, process.arch);
      mkdirSync(folder, {recursive: true});
      writeFileSync(path.join(folder, "bun"), `#!/bin/sh\nprintf '${version}\\n'\n`, {mode: 0o755});
      return folder;
    };
    const older = bunFolder("1.4.4");
    const newer = bunFolder("1.4.5");
    const managed = {SDK_RUNNER_ENVIRONMENT: "self-hosted", RUNNER_TOOL_CACHE: cache,
      PATH: `${newer}:${process.env.PATH}`, GITHUB_PATH: path.join(root, "path"),
      GITHUB_OUTPUT: path.join(root, "output")};
    assert.deepEqual(verify({...managed, SDK_BUN_VERSION: "1.4.4"}).versions, {bun: "1.4.4"});
    assert.deepEqual(verify({...managed, SDK_BUN_VERSION: "1.4.5"}).versions, {bun: "1.4.5"});
    main("verify", {...managed, SDK_BUN_VERSION: "1.4.4"});
    assert.equal(readFileSync(managed.GITHUB_PATH, "utf8"), older + "\n");
    const receipt = JSON.parse(readFileSync(managed.GITHUB_OUTPUT, "utf8").trim().slice("receipt=".length));
    assert.deepEqual(receipt.versions, {bun: "1.4.4"});
    assert.throws(() => verify({...managed, SDK_BUN_VERSION: "1.4.6"}), /selected bun executable/);
    assert.throws(() => verify({...managed, RUNNER_TOOL_CACHE: "relative", SDK_BUN_VERSION: "1.4.4"}), /RUNNER_TOOL_CACHE/);
    assert.deepEqual(verify({...managed, ...hosted, SDK_BUN_VERSION: "1.4.5"}).versions, {bun: "1.4.5"});
  } finally { rmSync(root, {recursive: true, force: true}); }
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

test("a managed runner selects the exact Python line from its uv installations", {skip: process.platform === "win32"}, () => {
  const root = mkdtempSync(path.join(tmpdir(), "hosted-sdk-"));
  try {
    const installs = path.join(root, "uv-python");
    const folder = path.join(installs, "cpython-3.15.2-linux-x86_64-gnu");
    mkdirSync(path.join(folder, "bin"), {recursive: true});
    writeFileSync(path.join(folder, "bin", "python"), "#!/bin/sh\necho 'Python 3.15.2'\n");
    chmodSync(path.join(folder, "bin", "python"), 0o755);
    writeFileSync(path.join(installs, "cpython-3.15.2-linux-x86_64-gnu.complete"), "");
    mkdirSync(path.join(installs, "cpython-3.15.20-linux-x86_64-gnu", "bin"), {recursive: true});
    mkdirSync(path.join(installs, "cpython-3.14.10-linux-x86_64-gnu", "bin"), {recursive: true});
    const managed = {...process.env, SDK_RUNNER_ENVIRONMENT: "self-hosted", SDK_MANAGED: "", SDK_PYTHON_VERSION: "3.15.2",
      UV_PYTHON_INSTALL_DIR: installs, PATH: path.join(root, "empty"),
      GITHUB_ENV: path.join(root, "environment"), GITHUB_OUTPUT: path.join(root, "output"),
      GITHUB_PATH: path.join(root, "path")};
    const bin = path.join(folder, "bin");
    assert.deepEqual(managedPython(managed), {bin, executable: path.join(bin, "python")});
    assert.throws(() => verify(managed), /selected python/);
    main("verify", managed);
    const receipt = JSON.parse(readFileSync(managed.GITHUB_OUTPUT, "utf8").trim().slice("receipt=".length));
    assert.deepEqual(receipt.versions, {python: "3.15.2"});
    assert.equal(readFileSync(managed.GITHUB_PATH, "utf8"), `${bin}\n`);
    assert.match(readFileSync(managed.GITHUB_ENV, "utf8"), new RegExp(`^UV_PYTHON=${path.join(bin, "python")}$`, "m"));
    assert.equal(managedPython({...managed, SDK_RUNNER_ENVIRONMENT: "github-hosted"}), null);
    assert.equal(managedPython({...managed, UV_PYTHON_INSTALL_DIR: ""}), null);
    assert.equal(managedPython({...managed, SDK_PYTHON_VERSION: ""}), null);
    assert.equal(managedPython({...managed, SDK_PYTHON_VERSION: "3.13.18"}), null);
    assert.throws(() => main("verify", {...managed, SDK_PYTHON_VERSION: "3.13.18"}), /selected python/);
    assert.throws(() => managedPython({...managed, UV_PYTHON_INSTALL_DIR: "uv-python"}), /absolute/);
    mkdirSync(path.join(installs, "cpython-3.15.2-linux-x86_64_v3-gnu"));
    assert.throws(() => managedPython(managed), /more than one Python 3.15.2/);
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
  const mac = cachePlan({...base, ImageOS: "macos15", SDK_NODE_VERSION: "26.13.0", SDK_PYTHON_VERSION: "3.15.2"}, "darwin");
  assert.equal(mac.key, "nddev-sdk-v1-macos15-ARM64-node-26.13.0");
  assert.deepEqual(mac.paths, [path.join("cache", "tools", "node", "26.13.0")]);
  const plan = cachePlan({...base, SDK_NODE_VERSION: "26.13.0", SDK_PYTHON_VERSION: "3.15.2",
    SDK_UV_VERSION: "0.13.7", SDK_BUN_VERSION: "1.4.4"}, "linux");
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
      SDK_NODE_VERSION: "26.13.0", GITHUB_OUTPUT: path.join(root, "output")};
    main("validate", environment);
    const output = readFileSync(environment.GITHUB_OUTPUT, "utf8");
    assert.match(output, /^cache-key=nddev-sdk-v1-macos15-ARM64-node-26\.13\.0$/m);
    assert.ok(output.includes(`cache-paths<<NDDEV_SDK_PATHS\n${path.join(root, "node", "26.13.0")}\nNDDEV_SDK_PATHS\n`));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("Flutter is selected only where it publishes an SDK", () => {
  supported({flutter: "3.47.9"}, "linux", "x64");
  supported({flutter: "3.47.9"}, "win32", "x64");
  supported({flutter: "3.47.9"}, "darwin", "arm64");
  supported({node: "26.13.0"}, "linux", "arm64");
  assert.throws(() => supported({flutter: "3.47.9"}, "linux", "arm64"), /x64 runner/);
  assert.throws(() => supported({flutter: "3.47.9"}, "win32", "arm64"), /x64 runner/);
  supported({java: "25.0.5"}, "linux", "arm64");
  supported({java: "25.0.5"}, "win32", "x64");
  assert.throws(() => supported({java: "25.0.5"}, "win32", "arm64"), /Windows on ARM64/);
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

test("tools are exact name@version entries, each name once", () => {
  selections({...hosted, SDK_TOOLS: "cargo-nextest@0.9.151,cargo-deny@0.20.2,just@1.59.0"});
  for (const value of ["cargo-nextest", "cargo-nextest@latest", "cargo-nextest@0.9", "Cargo@1.0.0",
    "a@1.0.0,a@1.0.1", "a@1.0.0;b@1.0.0", "a@1.0.0, b@1.0.0", "a@01.0.0"])
    assert.throws(() => selections({...hosted, SDK_TOOLS: value}), value);
});


test("the actual SDK cache save condition admits only integration-branch writers", () => {
  const action = readFileSync(new URL("../actions/hosted-sdk/action.yml", import.meta.url), "utf8");
  const block = action.split("- name: Keep exact SDKs in the tool cache\n")[1];
  assert.ok(block);
  const condition = block.split("uses:")[0].replace(/^\s*if:\s*(?:>-)?/, "").trim()
    .replace(/\.(cache-key|cache-hit|tool-cache)\b/g, (_, key) => "[" + JSON.stringify(key) + "]");
  function saves(event, ref, key = "exact-sdk", hit = "false") {
    return runInNewContext(condition, {
      github: {event_name: event, ref},
      steps: {validate: {outputs: {"cache-key": key}}, "tool-cache": {outputs: {"cache-hit": hit}}},
    });
  }
  for (const ref of ["refs/heads/dev", "refs/heads/main"]) {
    for (const event of ["push", "schedule", "workflow_dispatch"]) {
      assert.equal(saves(event, ref), true, event + ":" + ref);
      assert.equal(saves(event, ref, ""), false);
      assert.equal(saves(event, ref, "exact-sdk", "true"), false);
    }
  }
  for (const event of ["push", "schedule", "workflow_dispatch", "pull_request", "pull_request_target", "workflow_run"]) {
    for (const ref of ["refs/pull/192/merge", "refs/heads/fix/cache", "refs/tags/v1.0.0"]) {
      assert.equal(saves(event, ref), false, event + ":" + ref);
    }
    if (!["push", "schedule", "workflow_dispatch"].includes(event)) {
      assert.equal(saves(event, "refs/heads/dev"), false);
      assert.equal(saves(event, "refs/heads/main"), false);
    }
  }
});

test("native Rust target lists preserve underscores and reject malformed lists", () => {
  const base = {...hosted, SDK_RUST_VERSION: "1.99.1", SDK_RUST_COMPONENTS: "clippy"};
  for (const targets of [
    "aarch64-apple-ios,aarch64-apple-ios-sim,x86_64-apple-ios",
    "aarch64-linux-android,armv7-linux-androideabi,i686-linux-android,x86_64-linux-android",
    "x86_64-unknown-linux-gnu",
  ]) assert.deepEqual(selections({...base, SDK_RUST_TARGETS: targets}), {rust: "1.99.1"});
  for (const targets of [",x86_64-apple-ios", "x86_64-apple-ios,", "aarch64-apple-ios,,x86_64-apple-ios",
    "x86_64-apple-ios\n", " x86_64-apple-ios", "x86_64-apple-ios, x86_64-linux-android",
    "--target=x86_64-apple-ios", "x86_64/apple/ios", "x86_64-apple-ios;echo", "$(command)", "*"]) {
    assert.throws(() => selections({...base, SDK_RUST_TARGETS: targets}), targets);
  }
});

test("exact Java update and build identifiers survive selection and cache planning", () => {
  for (const version of ["25.0.5", "25.0.5+9", "25.0.4.1", "25.0.4.1+1"]) {
    const selected = {...hosted, SDK_JAVA_VERSION: version};
    assert.deepEqual(selections(selected), {java: version});
    assert.deepEqual(cachePlan(selected), {key: "", paths: []});
  }
  for (const version of ["25", "25.0", "25.x", "latest", "stable", ">=25.0.4", "25.0.4-ea",
    "25.0.4.1+1-ea", "25.0.4.1+", "25.0.4.1+01", "025.0.4", "25.00.4", "25.0.4\n", "25.0.4+1\n",
    " 25.0.4.1+1", "25.0.4.1+1,26.0.0", "$(command)"])
    assert.throws(() => selections({...hosted, SDK_JAVA_VERSION: version}), version);
});

test("Java runtime banners preserve patch and build identity without accepting missing or conflicting builds", () => {
  const output = "openjdk 25.0.4.1 2026-08-18\nOpenJDK Runtime Environment Temurin-25.0.4.1+1 (build 25.0.4.1+1)\n";
  assert.equal(javaVersion(output, "25.0.4.1+1"), "25.0.4.1+1");
  assert.equal(javaVersion(output, "25.0.4.1"), "25.0.4.1");
  assert.equal(javaVersion(output.replace(/\n/g, "\r\n"), "25.0.4.1+1"), "25.0.4.1+1");
  assert.equal(javaVersion(output.replace("(build 25.0.4.1+1)", "(build 25.0.4.1+1-LTS)"), "25.0.4.1+1"), "25.0.4.1+1");
  assert.equal(javaVersion(output.replace("(build 25.0.4.1+1)", "(build 25.0.4.1+2)"), "25.0.4.1+1"), "25.0.4.1+2");
  assert.equal(javaVersion(output.split("\n")[0], "25.0.4.1+1"), undefined);
  assert.equal(javaVersion(output.replace("openjdk 25.0.4.1 ", "openjdk 25.0.4 "), "25.0.4.1+1"), undefined);
  assert.notEqual(javaVersion(output.replace(/\+1/g, "+1-ea"), "25.0.4.1+1"), "25.0.4.1+1");
});

test("Java VM omission of zero release fields preserves the exact selected SDK tuple", () => {
  const ga = "openjdk 25 2025-09-16\nOpenJDK Runtime Environment Temurin-25+36 (build 25+36)\n";
  assert.equal(javaVersion(ga, "25.0.0+36"), "25.0.0+36");
  assert.equal(javaVersion(ga, "25.0.0"), "25.0.0");
  assert.equal(javaVersion(ga.replace(/\+36/g, "+37"), "25.0.0+36"), "25.0.0+37");
  assert.notEqual(javaVersion(ga.replace(/\+36/g, "+36+extra"), "25.0.0+36"), "25.0.0+36");
  assert.notEqual(javaVersion(ga.replace(/25/g, "25.0.1"), "25.0.0+36"), "25.0.0+36");
});

test("validate emits a selection payload that verify consumes without repeating SDK env vars", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hosted-sdk-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "github-output");
  const envFile = path.join(root, "github-env");
  writeFileSync(output, "");
  writeFileSync(envFile, "");
  main("validate", {
    ...process.env,
    SDK_RUNNER_ENVIRONMENT: "self-hosted",
    SDK_MANAGED: "true",
    GITHUB_OUTPUT: output,
  });
  const lines = readFileSync(output, "utf8").split("\n");
  const selectionLine = lines.find((line) => line.startsWith("selection="));
  assert.ok(selectionLine, "validate must emit selection output");
  const payload = JSON.parse(selectionLine.slice("selection=".length));
  assert.equal(payload.SDK_RUNNER_ENVIRONMENT, "self-hosted");
  assert.equal(payload.SDK_MANAGED, "true");

  const verifyOut = path.join(root, "verify-output");
  writeFileSync(verifyOut, "");
  main("verify", {
    PATH: process.env.PATH,
    SDK_SELECTION: selectionLine.slice("selection=".length),
    GITHUB_OUTPUT: verifyOut,
    GITHUB_ENV: envFile,
  });
  const receiptLine = readFileSync(verifyOut, "utf8").split("\n").find((line) => line.startsWith("receipt="));
  assert.ok(receiptLine, "verify must emit receipt from SDK_SELECTION");
  const receipt = JSON.parse(receiptLine.slice("receipt=".length));
  assert.equal(receipt.schema_version, 1);
});

function runManagedVerify(root, extraEnv) {
  const out = path.join(root, "out");
  const ghPath = path.join(root, "path");
  const ghEnv = path.join(root, "env");
  main("verify", {
    SDK_RUNNER_ENVIRONMENT: "self-hosted",
    PATH: path.join(root, "empty"),
    GITHUB_OUTPUT: out,
    GITHUB_PATH: ghPath,
    GITHUB_ENV: ghEnv,
    ...extraEnv,
  });
  return {
    receipt: JSON.parse(readFileSync(out, "utf8").trim().slice("receipt=".length)),
    exportedPath: existsSync(ghPath) ? readFileSync(ghPath, "utf8") : "",
    exportedEnv: existsSync(ghEnv) ? readFileSync(ghEnv, "utf8") : "",
  };
}

test("dotnet and ruby exact versions validate and verify across hosted and managed profiles", {skip: process.platform === "win32"}, () => {
  assert.deepEqual(
    selections({...hosted, SDK_DOTNET_VERSION: "11.0.100", SDK_RUBY_VERSION: "4.0.10"}),
    {dotnet: "11.0.100", ruby: "4.0.10"},
  );
  assert.throws(() => selections({...hosted, SDK_DOTNET_VERSION: "11.0"}));
  assert.throws(() => selections({...hosted, SDK_RUBY_VERSION: "4.0"}));

  const root = mkdtempSync(path.join(tmpdir(), "managed-dotnet-ruby-"));
  try {
    const cache = path.join(root, "cache");
    const dotnetDir = path.join(cache, "dotnet", "11.0.100", process.arch);
    const rubyBin = path.join(cache, "ruby", "4.0.10", process.arch, "bin");
    mkdirSync(dotnetDir, {recursive: true});
    mkdirSync(rubyBin, {recursive: true});
    writeFileSync(path.join(dotnetDir, "dotnet"), "#!/bin/sh\nprintf '11.0.100\\n'\n", {mode: 0o755});
    writeFileSync(path.join(rubyBin, "ruby"), "#!/bin/sh\nprintf 'ruby 4.0.10 (2026-11-01) [x86_64-linux]\\n'\n", {mode: 0o755});

    const { receipt, exportedPath } = runManagedVerify(root, {
      RUNNER_TOOL_CACHE: cache,
      SDK_DOTNET_VERSION: "11.0.100",
      SDK_RUBY_VERSION: "4.0.10",
    });
    assert.deepEqual(receipt.versions, {dotnet: "11.0.100", ruby: "4.0.10"});
    assert.ok(exportedPath.includes(dotnetDir));
    assert.ok(exportedPath.includes(rubyBin));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("managed SDK resolves Temurin JDK, uv arch aliases, Flutter, Dart, Rust toolchain and bin/ tool aliases", {skip: process.platform === "win32"}, () => {
  const root = mkdtempSync(path.join(tmpdir(), "managed-multiline-sdk-"));
  try {
    const cache = path.join(root, "cache");
    const archAlias = process.arch === "x64" ? "x86_64" : (process.arch === "arm64" ? "aarch64" : process.arch);

    const jdkHome = path.join(cache, "Java_Temurin-Hotspot_jdk", "25.0.5.1", process.arch);
    mkdirSync(path.join(jdkHome, "bin"), {recursive: true});
    writeFileSync(
      path.join(jdkHome, "bin", "java"),
      "#!/bin/sh\nprintf 'openjdk 25.0.5.1 2026-10-01\\nOpenJDK Runtime Environment Temurin-25.0.5.1+2 (build 25.0.5.1+2)\\n'\n",
      {mode: 0o755},
    );

    const uvDir = path.join(cache, "uv", "0.13.10", archAlias);
    mkdirSync(uvDir, {recursive: true});
    writeFileSync(path.join(uvDir, "uv"), "#!/bin/sh\nprintf 'uv 0.13.10\\n'\n", {mode: 0o755});

    const flutterHome = path.join(cache, "flutter", `stable-3.50.1-${process.arch}`, "flutter");
    mkdirSync(path.join(flutterHome, "bin"), {recursive: true});
    writeFileSync(
      path.join(flutterHome, "bin", "flutter"),
      "#!/bin/sh\nprintf '{\"frameworkVersion\":\"3.50.1\",\"dartSdkVersion\":\"3.14.1 (stable)\"}\\n'\n",
      {mode: 0o755},
    );

    const dartBin = path.join(cache, "dart", `3.14.1-${process.arch}`, "dart-sdk", "bin");
    mkdirSync(dartBin, {recursive: true});
    writeFileSync(
      path.join(dartBin, "dart"),
      "#!/bin/sh\nprintf 'Dart SDK version: 3.14.1 (stable) on linux_x64\\n' >&2\n",
      {mode: 0o755},
    );

    const cmakeBin = path.join(cache, "cmake", "4.5.1", process.arch, "bin");
    mkdirSync(cmakeBin, {recursive: true});
    writeFileSync(path.join(cmakeBin, "cmake"), "#!/bin/sh\nprintf 'cmake version 4.5.1\\n'\n", {mode: 0o755});

    const mavenBin = path.join(cache, "maven", "3.10.2", process.arch, "bin");
    mkdirSync(mavenBin, {recursive: true});
    writeFileSync(path.join(mavenBin, "mvn"), "#!/bin/sh\nprintf 'Apache Maven 3.10.2 (abc)\\n'\n", {mode: 0o755});

    const batsBin = path.join(cache, "bats-core", "1.14.0", process.arch, "bin");
    mkdirSync(batsBin, {recursive: true});
    writeFileSync(path.join(batsBin, "bats"), "#!/bin/sh\nprintf 'Bats 1.14.0\\n'\n", {mode: 0o755});

    const rustBin = path.join(root, "rust-bin");
    mkdirSync(rustBin, {recursive: true});
    writeFileSync(
      path.join(rustBin, "rustc"),
      "#!/bin/sh\nprintf 'rustc %s (000000000 2026-11-01)\\n' \"${RUSTUP_TOOLCHAIN:-0.0.0}\"\n",
      {mode: 0o755},
    );

    const out = path.join(root, "out");
    const ghPath = path.join(root, "path");
    const ghEnv = path.join(root, "env");
    const env = {
      SDK_RUNNER_ENVIRONMENT: "self-hosted",
      RUNNER_TOOL_CACHE: cache,
      PATH: rustBin,
      SDK_JAVA_VERSION: "25.0.5.1+2",
      SDK_UV_VERSION: "0.13.10",
      SDK_DART_VERSION: "3.14.1",
      SDK_RUST_VERSION: "1.100.0",
      ...(process.platform === "darwin" || process.arch === "x64" ? { SDK_FLUTTER_VERSION: "3.50.1" } : {}),
      SDK_TOOLS: "cmake@4.5.1,maven@3.10.2,bats-core@1.14.0",
      GITHUB_OUTPUT: out,
      GITHUB_PATH: ghPath,
      GITHUB_ENV: ghEnv,
    };

    assert.deepEqual(managedTools(env), [cmakeBin, mavenBin, batsBin]);
    main("verify", env);

    const receipt = JSON.parse(readFileSync(out, "utf8").trim().slice("receipt=".length));
    assert.equal(receipt.versions.java, "25.0.5.1+2");
    assert.equal(receipt.versions.uv, "0.13.10");
    assert.equal(receipt.versions.dart, "3.14.1");
    assert.equal(receipt.versions.rust, "1.100.0");
    if (process.platform === "darwin" || process.arch === "x64") {
      assert.equal(receipt.versions.flutter, "3.50.1");
    }
    assert.deepEqual(receipt.tools, {cmake: "4.5.1", maven: "3.10.2", "bats-core": "1.14.0"});

    const exportedEnv = readFileSync(ghEnv, "utf8");
    assert.match(exportedEnv, new RegExp(`^JAVA_HOME=${jdkHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.match(exportedEnv, /^RUSTUP_TOOLCHAIN=1\.100\.0$/m);
    if (process.platform === "darwin" || process.arch === "x64") {
      assert.match(exportedEnv, new RegExp(`^FLUTTER_ROOT=${flutterHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

const sampleAndroidManifest = `<?xml version="1.0" encoding="UTF-8"?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03" xmlns:common="http://schemas.android.com/repository/android/common/02" xmlns:generic="http://schemas.android.com/repository/android/generic/02" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <license id="android-sdk-license" type="text">Terms and Conditions</license>
  <remotePackage path="cmdline-tools;23.0">
    <type-details xsi:type="generic:genericDetailsType"/>
    <revision><major>23</major><minor>0</minor></revision>
    <display-name>Android SDK Command-line Tools</display-name>
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="channel-0"/>
    <archives>
      <archive>
        <complete><size>181052239</size><checksum type="sha1">e025545c62a8e64c7559119566a569fb1dec5f60</checksum><url>commandlinetools-linux-16111833_latest.zip</url></complete>
        <host-os>linux</host-os>
      </archive>
      <archive>
        <complete><size>155582504</size><checksum type="sha1">112cf9618794a997ff273537d55bee02c22abffe</checksum><url>commandlinetools-mac_x86_64-16111833_latest.zip</url></complete>
        <host-os>macosx</host-os>
        <host-arch>x64</host-arch>
      </archive>
      <archive>
        <complete><size>155384151</size><checksum type="sha1">ad03dc49bfacfd52c110b14104ea548b8a07e830</checksum><url>commandlinetools-mac_arm64-16111833_latest.zip</url></complete>
        <host-os>macosx</host-os>
        <host-arch>aarch64</host-arch>
      </archive>
      <archive>
        <complete><size>154957218</size><checksum type="sha1">57d04f2d75eb8e8fffc5000a987e5de4b5a63e9d</checksum><url>commandlinetools-win-16111833_latest.zip</url></complete>
        <host-os>windows</host-os>
      </archive>
    </archives>
  </remotePackage>
  <remotePackage path="platform-tools">
    <type-details xsi:type="generic:genericDetailsType"/>
    <revision><major>37</major><minor>0</minor><micro>3</micro></revision>
    <display-name>Android SDK Platform-Tools</display-name>
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="channel-0"/>
    <archives>
      <archive>
        <complete><size>9571024</size><checksum type="sha1">e1579b288a7ae4e9bc28dedec6a154d78b3c04ed</checksum><url>platform-tools_r37.0.3-linux.zip</url></complete>
        <host-os>linux</host-os>
      </archive>
      <archive>
        <complete><size>16597626</size><checksum type="sha1">d48920e2650321710b4d15d3acd9e277d59cd55b</checksum><url>platform-tools_r37.0.3-darwin.zip</url></complete>
        <host-os>macosx</host-os>
      </archive>
    </archives>
  </remotePackage>
  <remotePackage path="platforms;android-37.0">
    <type-details xsi:type="sdk:platformDetailsType"><api-level>37.0</api-level></type-details>
    <revision><major>2</major></revision>
    <display-name>Android SDK Platform 37.0</display-name>
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="channel-0"/>
    <archives>
      <archive>
        <complete><size>67281901</size><checksum type="sha1">ed8ebf7f8822a4de5686d427f237d2fa30ff7410</checksum><url>platform-37.0_r02.zip</url></complete>
      </archive>
    </archives>
  </remotePackage>
  <remotePackage path="cmake;4.1.2">
    <type-details xsi:type="generic:genericDetailsType"/>
    <revision><major>4</major><minor>1</minor><micro>2</micro></revision>
    <display-name>CMake 4.1.2</display-name>
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="channel-0"/>
    <archives>
      <archive>
        <complete><size>31275750</size><checksum type="sha1">c8c4f1c19b75c56f28b9dcf1af928d25cf1a1471</checksum><url>cmake-4.1.2-linux.zip</url></complete>
        <host-os>linux</host-os>
      </archive>
    </archives>
  </remotePackage>
  <remotePackage path="build-tools;37.0.0">
    <type-details xsi:type="generic:genericDetailsType"/>
    <revision><major>37</major><minor>0</minor><micro>0</micro></revision>
    <display-name>Android SDK Build-Tools 37</display-name>
    <uses-license ref="android-sdk-license"/>
    <channelRef ref="channel-1"/>
    <archives>
      <archive>
        <complete><size>66135704</size><checksum type="sha1">70954e99f4c3d9d46ee70fa32624672fe7cd6ebe</checksum><url>build-tools_r37_linux.zip</url></complete>
        <host-os>linux</host-os>
      </archive>
    </archives>
  </remotePackage>
</sdk:sdk-repository>
`;

test("Android SDK specs and repository2-3.xml resolution enforce exact stable packages and platform support", () => {
  const parsed = parseAndroidSdkSpec("android-cmdline-tools@23.0,platform-tools@37.0.3,build-tools@37.0.0,platform@37.0,ndk@28.2.13676358,cmake@3.22.1");
  assert.equal(parsed.normalized, "cmdline-tools@23.0,platform-tools@37.0.3,build-tools@37.0.0,platform@37.0,ndk@28.2.13676358,cmake@3.22.1");
  assert.deepEqual(parsed.versions, {
    "cmdline-tools": "23.0",
    "platform-tools": "37.0.3",
    "build-tools": "37.0.0",
    platform: "37.0",
    ndk: "28.2.13676358",
    cmake: "3.22.1",
  });
  for (const bad of ["cmdline-tools", "unknown@1.0.0", "ndk@1.0.0,android-ndk@2.0.0", "build-tools@latest", "platform@android-37"]) {
    assert.throws(() => parseAndroidSdkSpec(bad), bad);
  }

  const linCmd = parseAndroidPackage(sampleAndroidManifest, "cmdline-tools", "23.0", "linux", "x64");
  assert.equal(linCmd.filename, "commandlinetools-linux-16111833_latest.zip");
  assert.equal(linCmd.size, 181052239);
  assert.equal(linCmd.algorithm, "sha1");
  assert.equal(linCmd.strip, 1);
  assert.match(linCmd.packageXml, /<localPackage path="cmdline-tools;23\.0" obsolete="false">/);
  assert.doesNotMatch(linCmd.packageXml, /<archives>|<channelRef/);

  const macArmCmd = parseAndroidPackage(sampleAndroidManifest, "cmdline-tools", "23.0", "darwin", "arm64");
  assert.equal(macArmCmd.filename, "commandlinetools-mac_arm64-16111833_latest.zip");
  const macX64Cmd = parseAndroidPackage(sampleAndroidManifest, "cmdline-tools", "23.0", "darwin", "x64");
  assert.equal(macX64Cmd.filename, "commandlinetools-mac_x86_64-16111833_latest.zip");
  const winCmd = parseAndroidPackage(sampleAndroidManifest, "cmdline-tools", "23.0", "win32", "x64");
  assert.equal(winCmd.filename, "commandlinetools-win-16111833_latest.zip");

  const pt = parseAndroidPackage(sampleAndroidManifest, "platform-tools", "37.0.3", "linux", "x64");
  assert.equal(pt.filename, "platform-tools_r37.0.3-linux.zip");
  assert.throws(() => parseAndroidPackage(sampleAndroidManifest, "platform-tools", "37.0.2", "linux", "x64"), /no single stable/);

  const plat = parseAndroidPackage(sampleAndroidManifest, "platform", "37.0", "darwin", "arm64");
  assert.equal(plat.filename, "platform-37.0_r02.zip");

  const cm = parseAndroidPackage(sampleAndroidManifest, "cmake", "4.1.2", "linux", "x64");
  assert.equal(cm.strip, 0);

  // Non-stable channel-1 package is rejected.
  assert.throws(() => parseAndroidPackage(sampleAndroidManifest, "build-tools", "37.0.0", "linux", "x64"), /no single stable/);
  // Unsupported host architectures are rejected.
  assert.throws(() => parseAndroidPackage(sampleAndroidManifest, "cmdline-tools", "23.0", "linux", "arm64"), /x64 or macOS/);
  assert.throws(() => parseAndroidPackage(sampleAndroidManifest, "cmdline-tools", "23.0", "win32", "arm64"), /x64 or macOS/);
  assert.throws(() => supported({}, "linux", "arm64", parsed.entries), /x64 or macOS/);
  assert.throws(() => supported({}, "win32", "arm64", parsed.entries), /x64 or macOS/);
  supported({}, "linux", "x64", parsed.entries);
  supported({}, "darwin", "arm64", parsed.entries);
});

test("Android SDK cache planning, license acceptance and managed verification follow the managed ANDROID_HOME layout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "android-sdk-verify-"));
  try {
    const cache = path.join(root, "cache");
    const plan = cachePlan({
      ...hosted,
      RUNNER_TOOL_CACHE: cache,
      ImageOS: "ubuntu24",
      RUNNER_ARCH: "X64",
      SDK_ANDROID_SDK: "platform-tools@37.0.3,cmdline-tools@23.0",
    });
    assert.equal(plan.key, "nddev-sdk-v1-ubuntu24-X64-android-cmdline-tools-23.0-android-platform-tools-37.0.3");
    assert.deepEqual(plan.paths, [
      path.join(cache, "android", "cmdline-tools", "23.0"),
      path.join(cache, "android", "platform-tools"),
      path.join(cache, "android", "licenses"),
    ]);

    const androidHome = path.join(cache, "android");
    writeAndroidLicenses(androidHome, [{ licenseId: "android-sdk-license", licenseText: "Terms and Conditions" }]);
    const licText = readFileSync(path.join(androidHome, "licenses", "android-sdk-license"), "utf8");
    assert.ok(licText.includes("24333f8a63b6825ea9c5514f83c2829b004d1fee"));
    assert.ok(licText.includes("da39a3ee5e6b4b0d3255bfef95601890afd80709"));

    if (process.platform === "darwin" || process.arch === "x64") {
      const cmdDir = path.join(androidHome, "cmdline-tools", "23.0");
      mkdirSync(path.join(cmdDir, "bin"), { recursive: true });
      writeFileSync(path.join(cmdDir, "bin", process.platform === "win32" ? "sdkmanager.bat" : "sdkmanager"), "", { mode: 0o755 });
      writeFileSync(path.join(cmdDir, "package.xml"),
        '<localPackage path="cmdline-tools;23.0" obsolete="false"><revision><major>23</major><minor>0</minor></revision></localPackage>');

      const ptDir = path.join(androidHome, "platform-tools");
      mkdirSync(ptDir, { recursive: true });
      writeFileSync(path.join(ptDir, process.platform === "win32" ? "adb.exe" : "adb"), "", { mode: 0o755 });
      writeFileSync(path.join(ptDir, "package.xml"),
        '<localPackage path="platform-tools" obsolete="false"><revision><major>37</major><minor>0</minor><micro>3</micro></revision></localPackage>');

      const platDir = path.join(androidHome, "platforms", "android-37.0");
      mkdirSync(platDir, { recursive: true });
      writeFileSync(path.join(platDir, "android.jar"), "");
      writeFileSync(path.join(platDir, "package.xml"),
        '<localPackage path="platforms;android-37.0" obsolete="false"><revision><major>2</major></revision></localPackage>');

      // Fallback to source.properties when package.xml is absent.
      const ndkDir = path.join(androidHome, "ndk", "28.2.13676358");
      mkdirSync(ndkDir, { recursive: true });
      writeFileSync(path.join(ndkDir, "source.properties"), "Pkg.Desc = Android NDK\nPkg.Revision = 28.2.13676358\n");

      const { receipt, exportedEnv, exportedPath } = runManagedVerify(root, {
        RUNNER_TOOL_CACHE: cache,
        SDK_ANDROID_SDK: "cmdline-tools@23.0,platform-tools@37.0.3,platform@37.0,ndk@28.2.13676358",
      });
      assert.deepEqual(receipt.android, {
        "cmdline-tools": "23.0",
        "platform-tools": "37.0.3",
        platform: "37.0",
        ndk: "28.2.13676358",
      });
      assert.ok(exportedEnv.includes(`ANDROID_HOME=${androidHome}`));
      assert.ok(exportedEnv.includes(`ANDROID_SDK_ROOT=${androidHome}`));
      assert.ok(exportedPath.includes(path.join(cmdDir, "bin")));
      assert.ok(exportedPath.includes(ptDir));

      // Mismatched revision must fail verification cleanly.
      assert.throws(() => verify({
        SDK_RUNNER_ENVIRONMENT: "self-hosted",
        RUNNER_TOOL_CACHE: cache,
        PATH: path.join(root, "empty"),
        SDK_ANDROID_SDK: "platform-tools@37.0.2",
      }), /reports revision 37\.0\.3/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
