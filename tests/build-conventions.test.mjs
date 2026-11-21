import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findings } from "../lib/build-conventions.mjs";
import { main } from "../actions/build-conventions/run.mjs";

test("tracked build lines that break a convention are named; comments, documents and kept ones are not", () => {
  const root = mkdtempSync(join(tmpdir(), "build-conventions-"));
  try {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(root, "justfile"),
      [
        "check:",
        '    GRADLE_USER_HOME="$RUNNER_TEMP/gradle" ./gradlew check',
        "    docker buildx build -t app --load .",
        "    docker buildx build $NDDEV_CI_IMAGE_BUILD_FLAGS -t app --load .",
        "    docker buildx build --cache-to type=local,dest=/c --cache-from type=local,src=/c $NDDEV_CI_IMAGE_BUILD_FLAGS .",
        "    docker build --help",
        "",
      ].join("\n"),
    );
    writeFileSync(join(root, ".github/workflows/ci.yml"), "env:\n  GRADLE_USER_HOME: /tmp/g\n");
    writeFileSync(join(root, "build.sh"), '# docker build -t x .\necho "$GRADLE_USER_HOME"\n');
    writeFileSync(join(root, "README.md"), "Run docker build -t x . locally.\n");
    writeFileSync(join(root, "untracked.sh"), "docker build -t y .\n");
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "tests/fixture.sh"), "docker build -t z .\n");
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "add", "justfile", ".github", "build.sh", "README.md", "tests"]);
    assert.deepEqual(
      findings(root).map(({ path, line, rule }) => [path, line, rule]),
      [
        [".github/workflows/ci.yml", 2, "gradle-home"],
        ["justfile", 2, "gradle-home"],
        ["justfile", 3, "image-build-flags"],
        ["justfile", 5, "local-layer-cache"],
      ],
    );
    const lines = [];
    assert.equal(main({ GITHUB_WORKSPACE: root }, (line) => lines.push(line)), 4);
    assert.match(lines[2], /^::warning file=justfile,line=3::This image build skips/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
