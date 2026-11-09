import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, selections, verify } from "../actions/hosted-sdk/run.mjs";

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
