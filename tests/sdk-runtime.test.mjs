import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, verify } from "../actions/hosted-sdk/run.mjs";

test("the actual SDK phase scripts work without a Node SDK on PATH", () => {
  const action = readFileSync(new URL("../actions/hosted-sdk/action.yml", import.meta.url), "utf8");
  const scripts = [...action.matchAll(/        script: \|\n((?:          [^\n]*\n)+)/g)]
    .map((match) => match[1].split("\n").map((line) => line.slice(10)).join("\n"));
  assert.equal(scripts.length, 4);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const script of scripts) new AsyncFunction("require", script);
  const root = mkdtempSync(path.join(tmpdir(), "sdk-action-runtime-"));
  try {
    for (const phase of ["validate", "verify"]) {
      const script = scripts.find((source) => source.includes(`action.main("${phase}")`));
      assert.ok(script);
      const entry = path.join(root, `${phase}.cjs`), output = path.join(root, `${phase}.out`);
      writeFileSync(entry, `(async () => {\n${script}\n})().catch(() => {process.exitCode = 1});\n`);
      const result = spawnSync(process.execPath, [entry], {encoding: "utf8", env: {...process.env, PATH: "", Path: "",
        SDK_ACTION_PATH: fileURLToPath(new URL("../actions/hosted-sdk", import.meta.url)),
        SDK_RUNNER_ENVIRONMENT: "self-hosted", SDK_MANAGED: "true", SDK_NODE_VERSION: "", SDK_PYTHON_VERSION: "",
        SDK_BUN_VERSION: "", SDK_UV_VERSION: "", SDK_RUST_VERSION: "", SDK_JAVA_VERSION: "", SDK_GO_VERSION: "",
        SDK_FLUTTER_VERSION: "", SDK_TOOLS: "", SDK_RUST_COMPONENTS: "", SDK_RUST_TARGETS: "",
        GITHUB_OUTPUT: output, GITHUB_ENV: path.join(root, "environment")}});
      assert.equal(result.status, 0, result.stderr);
      const text = readFileSync(output, "utf8");
      if (phase === "validate") assert.match(text, /^bootstrap=false$/m);
      else assert.deepEqual(JSON.parse(text.trim().slice("receipt=".length)).versions, {});
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

function rustProfile() {
  const environment = {...process.env, SDK_RUNNER_ENVIRONMENT: "self-hosted", SDK_MANAGED: "true",
    SDK_NODE_VERSION: "", SDK_PYTHON_VERSION: "", SDK_UV_VERSION: "", SDK_BUN_VERSION: "",
    SDK_JAVA_VERSION: "", SDK_GO_VERSION: "", SDK_FLUTTER_VERSION: "", SDK_TOOLS: "",
    SDK_RUST_COMPONENTS: "", SDK_RUST_TARGETS: "", RUSTUP_AUTO_INSTALL: "0"};
  function read(command, args) {
    const result = spawnSync(command, args, {env: environment, encoding: "utf8", windowsHide: true, timeout: 30000});
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return result.stdout.trim();
  }
  const compiler = read("rustc", ["-vV"]);
  environment.SDK_RUST_VERSION = compiler.match(/^release: (\d+\.\d+\.\d+)$/m)?.[1];
  assert.ok(environment.SDK_RUST_VERSION, compiler);
  environment.RUSTUP_TOOLCHAIN = environment.SDK_RUST_VERSION;
  const host = compiler.match(/^host: ([a-z0-9-]+)$/m)?.[1];
  assert.ok(host, compiler);
  const inventory = (kind, installed = true) => read("rustup", [
    kind, "list", "--toolchain", environment.SDK_RUST_VERSION, "--quiet", ...(installed ? ["--installed"] : []),
  ]).split(/\r?\n/).filter(Boolean);
  return {environment, host, inventory};
}

test("a complete Rust profile verifies requested components and targets for the selected toolchain", () => {
  const {environment, host, inventory} = rustProfile();
  const components = inventory("component"), targets = inventory("target");
  for (const component of ["rustfmt", "clippy"])
    assert.ok(components.includes(component + "-" + host), component + " must be supplied by the CI profile");
  assert.ok(targets.includes(host));
  const requested = ["rustfmt", "clippy", "rustfmt-" + host, "clippy-" + host];
  if (components.includes("rust-src")) requested.push("rust-src");
  const root = mkdtempSync(path.join(tmpdir(), "managed-rust-sdk-"));
  try {
    const receipt = verify({...environment, RUSTUP_TOOLCHAIN: "0.0.0", RUSTUP_AUTO_INSTALL: "0",
      SDK_RUST_COMPONENTS: requested.join(","), SDK_RUST_TARGETS: host});
    assert.equal(receipt.versions.rust, environment.SDK_RUST_VERSION);
    assert.deepEqual(inventory("component"), components);
    assert.deepEqual(inventory("target"), targets);
    const empty = path.join(root, "empty-rustup");
    assert.throws(() => verify({...environment, RUSTUP_HOME: empty, RUSTUP_AUTO_INSTALL: "1",
      RUSTUP_DIST_SERVER: "http://127.0.0.1:9", RUSTUP_UPDATE_ROOT: "http://127.0.0.1:9",
      SDK_RUST_COMPONENTS: "rustfmt"}), /selected rust|Rust/);
    assert.equal(existsSync(path.join(empty, "toolchains")), false);
    assert.equal(existsSync(path.join(empty, "downloads")), false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("a present compiler cannot issue a receipt for a missing Rust component or target", () => {
  const {environment, inventory} = rustProfile();
  const before = {components: inventory("component"), targets: inventory("target")};
  const component = inventory("component", false).find(name => !before.components.includes(name));
  const target = inventory("target", false).find(name => !before.targets.includes(name));
  assert.ok(component, "The CI profile must expose an uninstalled component for the negative case.");
  assert.ok(target, "The CI profile must expose an uninstalled target for the negative case.");
  const root = mkdtempSync(path.join(tmpdir(), "managed-rust-sdk-missing-"));
  try {
    for (const [key, missing] of [["SDK_RUST_COMPONENTS", component], ["SDK_RUST_TARGETS", target]]) {
      const output = path.join(root, key + ".out"), variables = path.join(root, key + ".env");
      assert.throws(() => main("verify", {...environment, [key]: missing,
        GITHUB_OUTPUT: output, GITHUB_ENV: variables}), error => {
        assert.match(error.message, /Rust/);
        assert.ok(error.message.includes(missing), error.message);
        assert.ok(error.message.includes(environment.SDK_RUST_VERSION), error.message);
        return true;
      });
      assert.equal(existsSync(output), false, "Failure must precede the success receipt.");
      assert.equal(existsSync(variables), false, "Failure must precede exported environment changes.");
    }
    assert.deepEqual(inventory("component"), before.components);
    assert.deepEqual(inventory("target"), before.targets);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
