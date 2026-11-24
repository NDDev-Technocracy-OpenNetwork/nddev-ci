import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { cachePlan, imageKey, javaVersion, main, managedBun, managedPython, managedTools, selections, supported, verify } from "../actions/hosted-sdk/run.mjs";
import { selectRelease } from "../actions/hosted-sdk/flutter.mjs";
import { dartArchive, dartDigest } from "../actions/hosted-sdk/dart.mjs";

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
    const bunFolder = (version, arch = process.arch) => {
      const folder = path.join(cache, "bun", version, arch);
      mkdirSync(folder, {recursive: true});
      writeFileSync(path.join(folder, "bun"), `#!/bin/sh\nprintf '${version}\\n'\n`, {mode: 0o755});
      return folder;
    };
    const older = bunFolder("1.4.4");
    const newer = bunFolder("1.4.5");
    const managed = {SDK_RUNNER_ENVIRONMENT: "self-hosted", RUNNER_TOOL_CACHE: cache,
      PATH: `${newer}:${process.env.PATH}`, GITHUB_PATH: path.join(root, "path"),
      GITHUB_OUTPUT: path.join(root, "output")};
    assert.deepEqual(managedBun({...managed, SDK_BUN_VERSION: "1.4.4"}), {bin: older, executable: path.join(older, "bun")});
    assert.deepEqual(verify({...managed, SDK_BUN_VERSION: "1.4.4"}).versions, {bun: "1.4.4"});
    assert.deepEqual(verify({...managed, SDK_BUN_VERSION: "1.4.5"}).versions, {bun: "1.4.5"});
    main("verify", {...managed, SDK_BUN_VERSION: "1.4.4"});
    assert.equal(readFileSync(managed.GITHUB_PATH, "utf8"), older + "\n");
    const receipt = JSON.parse(readFileSync(managed.GITHUB_OUTPUT, "utf8").trim().slice("receipt=".length));
    assert.deepEqual(receipt.versions, {bun: "1.4.4"});
    assert.equal(managedBun({...managed, SDK_BUN_VERSION: "1.4.6"}), null);
    assert.throws(() => verify({...managed, SDK_BUN_VERSION: "1.4.6"}), /selected bun executable/);
    assert.equal(managedBun({...managed, ...hosted, SDK_BUN_VERSION: "1.4.4"}), null);
    assert.throws(() => managedBun({...managed, RUNNER_TOOL_CACHE: "relative", SDK_BUN_VERSION: "1.4.4"}), /RUNNER_TOOL_CACHE/);
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
