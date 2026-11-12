import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/check.yml", import.meta.url), "utf8");
const start = workflow.indexOf("      - name: App Git credentials\n");
assert.notEqual(start, -1);
const end = workflow.indexOf("      - name: Native task runner\n", start);
assert.notEqual(end, -1);
const script = workflow.slice(start, end).split("        run: |\n")[1]
  .split("\n").filter((line) => line.startsWith("          ")).map((line) => line.slice(10)).join("\n");

function prepared(t) {
  const root = mkdtempSync(join(tmpdir(), "nddev-ci-app-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "environment");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GITHUB_ENV: file,
    READ_TOKEN: "synthetic-read-token",
    READ_REPOSITORIES: "Example/private-one\nExample/private-two\n",
  };
  const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  for (const line of readFileSync(file, "utf8").trimEnd().split("\n")) {
    const index = line.indexOf("=");
    assert.ok(index > 0);
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

function git(env, args, input) {
  const result = spawnSync("git", args, { env, input, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd();
}

test("App Git credentials route the requested SSH and HTTPS sources through HTTPS without an SSH identity", (t) => {
  const env = prepared(t);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_SSH_COMMAND, undefined);
  for (const repository of ["Example/private-one", "Example/private-two"]) {
    for (const suffix of ["", ".git"]) {
      const expected = "https://github.com/" + repository + suffix;
      for (const address of [expected, "git@github.com:" + repository + suffix, "ssh://git@github.com/" + repository + suffix]) {
        assert.equal(git(env, ["ls-remote", "--get-url", address]), expected);
      }
    }
  }
  for (const address of ["ssh://git@github.com/Example/unrequested", "git@github.com:Another/private-one", "ssh://git@other.example/Example/private-one"]) {
    assert.equal(git(env, ["ls-remote", "--get-url", address]), address);
  }
});

test("the native HTTPS credential request reads the scoped token without embedding it in a Git URL", (t) => {
  const env = prepared(t);
  const result = git(env, ["credential", "fill"], "protocol=https\nhost=github.com\npath=Example/private-one.git\n\n");
  assert.match(result, /(?:^|\n)username=x-access-token(?:\n|$)/);
  assert.match(result, /(?:^|\n)password=synthetic-read-token(?:\n|$)/);
  assert.equal(git(env, ["ls-remote", "--get-url", "ssh://git@github.com/Example/private-one"]), "https://github.com/Example/private-one");
});
