import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { overrides } from "../lib/gradle-home.mjs";
import { main } from "../actions/gradle-home/run.mjs";

test("a tracked line that sets Gradle's home is named; comments, documents and reads are not", () => {
  const root = mkdtempSync(join(tmpdir(), "gradle-home-"));
  try {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, "justfile"), 'check:\n    GRADLE_USER_HOME="$RUNNER_TEMP/gradle" ./gradlew check\n');
    writeFileSync(join(root, ".github/workflows/ci.yml"), "env:\n  GRADLE_USER_HOME: /tmp/g\n");
    writeFileSync(join(root, "build.sh"), '# GRADLE_USER_HOME=x is the runner\'s\necho "$GRADLE_USER_HOME"\n');
    writeFileSync(join(root, "README.md"), "Set GRADLE_USER_HOME=x only locally.\n");
    writeFileSync(join(root, "untracked.sh"), "GRADLE_USER_HOME=y\n");
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "add", "justfile", ".github", "build.sh", "README.md"]);
    assert.deepEqual(overrides(root), [
      { path: ".github/workflows/ci.yml", line: 2 },
      { path: "justfile", line: 2 },
    ]);
    const lines = [];
    assert.equal(main({ GITHUB_WORKSPACE: root }, (line) => lines.push(line)), 2);
    assert.match(lines[0], /^::warning file=\.github\/workflows\/ci\.yml,line=2::GRADLE_USER_HOME replaces/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
