import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../tools/verify-before-push.mjs", import.meta.url));

test("managed push transfers one exact standalone source and binds its registry before running", {
  skip: process.platform !== "linux",
}, () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "pre-push-source-"));
  const source = path.join(temporary, "source");
  const receiver = path.join(temporary, "receiver");
  const bin = path.join(temporary, "bin");
  const bundle = path.join(temporary, "bundle");
  const argumentsFile = path.join(temporary, "arguments");
  const lock = "config/tools.lock.json";
  const registered = "a".repeat(40);
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    PATH: bin + path.delimiter + process.env.PATH,
    TEST_ARGUMENTS: argumentsFile,
    TEST_BUNDLE: bundle,
  };
  const git = (...arguments_) => execFileSync("git", arguments_, {
    cwd: source, env: environment, encoding: "utf8",
  }).trim();

  try {
    for (const folder of [source, receiver, bin]) mkdirSync(folder);
    mkdirSync(path.join(source, "config"));
    git("init", "--quiet", "--object-format=sha1", "--template=");
    git("config", "user.name", "Check qualification");
    git("config", "user.email", "check@example.com");
    writeFileSync(path.join(source, "justfile"), [
      "verify:",
      '    test "$GITHUB_SHA" = "$(git rev-parse HEAD)"',
      '    test -z "$(git status --porcelain)"',
      '    test -r "$NDDEV_CI_REGISTRY_SNAPSHOT"',
      "",
    ].join("\n"));
    const selection = registry_commit => JSON.stringify({ schema_version: 1, registry_commit });
    writeFileSync(path.join(source, lock), selection(registered));
    git("add", ".");
    git("commit", "--quiet", "-m", "candidate");
    const tip = git("rev-parse", "HEAD");
    writeFileSync(path.join(source, lock), selection("b".repeat(40)));
    writeFileSync(path.join(bin, "ssh"), [
      "#!/bin/sh",
      'printf "%s\\n" "$@" >> "$TEST_ARGUMENTS"',
      'cat > "$TEST_BUNDLE"',
      "",
    ].join("\n"), { mode: 0o700 });

    const snapshot = path.join(temporary, "registered.json");
    const bytes = Buffer.from(JSON.stringify({
      schema_version: 1, registry_commit: registered, technologies_toml: "",
    }));
    const digest = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(snapshot, bytes);
    const resolver = path.join(bin, "snapshot");
    writeFileSync(resolver, [
      "#!/bin/sh",
      'test "$1" = example/project && test "$2" = ' + registered + ' || exit 1',
      'cat -- "$TEST_REGISTRY"',
      "",
    ].join("\n"), { mode: 0o700 });
    environment.TEST_REGISTRY = snapshot;

    const send = () => spawnSync(process.execPath, [
      cli, "--send-managed", "build-test", "/trusted/build-check", "example/project", lock, resolver,
    ], {
      cwd: source, env: environment, encoding: "utf8",
      input: [
        "HEAD " + tip + " refs/heads/one " + "0".repeat(40),
        "HEAD " + tip + " refs/heads/two " + "0".repeat(40),
        "HEAD " + tip + " refs/tags/same " + "0".repeat(40),
        "",
      ].join("\n"),
    });
    const sent = send();
    assert.equal(sent.status, 0, sent.stderr);
    const argv = readFileSync(argumentsFile, "utf8").trim().split("\n");
    assert.deepEqual(argv, [
      "-T", "-oBatchMode=yes", "-oConnectTimeout=15", "--", "build-test", "/trusted/build-check",
    ]);
    const framed = readFileSync(bundle);
    const newline = framed.indexOf(10);
    assert.ok(newline > 0);
    const request = JSON.parse(framed.subarray(0, newline));
    const ref = request.transfer_ref;
    assert.match(ref, /^refs\/contour\/pre-push\/[a-f0-9-]{36}$/);
    assert.deepEqual(request, {
      schema_version: 1, repository: "example/project", commit: tip,
      transfer_ref: ref, registry: { commit: registered, sha256: digest, bytes: bytes.length },
    });
    assert.deepEqual(framed.subarray(newline + 1, newline + 1 + bytes.length), bytes);
    const gitBundle = framed.subarray(newline + 1 + bytes.length);
    writeFileSync(bundle, gitBundle);
    assert.equal(git("for-each-ref", "refs/contour/pre-push"), "");
    assert.equal(git("bundle", "list-heads", bundle), tip + " " + ref);

    const admission = {
      ...environment,
      NDDEV_CI_PRE_PUSH_REGISTRY_COMMIT: registered,
      NDDEV_CI_PRE_PUSH_REGISTRY_LOCK: lock,
      NDDEV_CI_PRE_PUSH_REGISTRY_SHA256: digest,
      NDDEV_CI_REGISTRY_SNAPSHOT: snapshot,
    };
    const run = (selected, env) => spawnSync(process.execPath, [
      cli, "--receive", "example/project", selected, ref, "none",
    ], { cwd: receiver, env, encoding: "utf8", input: gitBundle });
    const wrongSource = run("b".repeat(40), admission);
    assert.equal(wrongSource.status, 1);
    assert.match(wrongSource.stderr, /transferred source does not match/);
    const wrongRegistry = run(tip, { ...admission, NDDEV_CI_PRE_PUSH_REGISTRY_SHA256: "b".repeat(64) });
    assert.equal(wrongRegistry.status, 1);
    assert.match(wrongRegistry.stderr, /differs from its digest/);
    const accepted = run(tip, admission);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(readdirSync(receiver), []);

    writeFileSync(snapshot, JSON.stringify({
      schema_version: 1, registry_commit: "b".repeat(40), technologies_toml: "",
    }));
    const rejected = send();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /differs from the selected source/);
    assert.deepEqual(readFileSync(argumentsFile, "utf8").trim().split("\n"), argv);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
