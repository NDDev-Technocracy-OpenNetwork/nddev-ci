import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        "    cargo clippy --locked --all-targets -- -D warnings",
        "    CARGO_BUILD_WARNINGS=deny cargo clippy --locked --all-targets",
        "    just _cargo clippy --all-targets -- -Dwarnings",
        "    {{ quote(cargo) }} clippy --workspace -- --deny warnings",
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
        ["justfile", 7, "clippy-deny-warnings"],
        ["justfile", 9, "clippy-deny-warnings"],
        ["justfile", 10, "clippy-deny-warnings"],
      ],
    );
    const lines = [];
    assert.equal(main({ GITHUB_WORKSPACE: root }, (line) => lines.push(line)), 7);
    assert.match(lines[2], /^::warning file=justfile,line=3::This image build skips/);
    assert.match(lines[4], /^::warning file=justfile,line=7::Passing -D warnings/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Dockerfiles running package installs without mirror ARGs emit dockerfile-mirror-args warnings", () => {
  const root = mkdtempSync(join(tmpdir(), "build-conventions-docker-"));
  try {
    writeFileSync(
      join(root, "Dockerfile"),
      [
        "FROM rust:1.95 AS bad-rust",
        "RUN cargo build --locked --release",
        "FROM rust:1.95 AS good-rust",
        "ARG CARGO_SOURCE_CRATES_IO_REPLACE_WITH",
        "ARG CARGO_SOURCE_MIRROR_REGISTRY",
        "RUN cargo build --locked --release",
        "FROM oven/bun:1.4 AS bad-web",
        "RUN bun install --frozen-lockfile",
        "FROM oven/bun:1.4 AS good-web",
        "ARG NPM_CONFIG_REGISTRY",
        "RUN bun install --frozen-lockfile",
        "",
      ].join("\n"),
    );
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "add", "Dockerfile"]);
    assert.deepEqual(
      findings(root).map(({ path, line, rule }) => [path, line, rule]),
      [
        ["Dockerfile", 2, "dockerfile-mirror-args"],
        ["Dockerfile", 8, "dockerfile-mirror-args"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare exports CARGO_BUILD_WARNINGS=deny only for Rust jobs when unset", () => {
  const source = readFileSync(new URL("../actions/prepare/action.yml", import.meta.url), "utf8");
  const step = source.split("    - name: Cargo warnings\n")[1]?.split("\n    - name: ")[0];
  assert.ok(step, "Cargo warnings step exists in actions/prepare");
  const script = step
    .split(/      run: \|[^\n]*\n/)[1]
    .split("\n")
    .map((line) => line.replace(/^ {8}/, ""))
    .join("\n");
  const root = mkdtempSync(join(tmpdir(), "prepare-cargo-warnings-"));
  try {
    const envFile = join(root, "github-env");
    writeFileSync(envFile, "");
    const cleanEnv = { ...process.env, GITHUB_ENV: envFile };
    delete cleanEnv.CARGO_BUILD_WARNINGS;
    delete cleanEnv.RUST_VERSION;
    delete cleanEnv.WORKING_DIRECTORY;

    const nonRust = spawnSync("bash", ["-c", script], {
      cwd: root,
      env: cleanEnv,
      encoding: "utf8",
    });
    assert.equal(nonRust.status, 0, nonRust.stderr);
    assert.equal(readFileSync(envFile, "utf8"), "");

    writeFileSync(envFile, "");
    const withRustVersion = spawnSync("bash", ["-c", script], {
      cwd: root,
      env: { ...cleanEnv, RUST_VERSION: "1.100.0" },
      encoding: "utf8",
    });
    assert.equal(withRustVersion.status, 0, withRustVersion.stderr);
    assert.equal(readFileSync(envFile, "utf8"), "CARGO_BUILD_WARNINGS=deny\n");

    writeFileSync(envFile, "");
    writeFileSync(join(root, "Cargo.toml"), "[package]\nname = \"demo\"\n");
    const withCargoToml = spawnSync("bash", ["-c", script], {
      cwd: root,
      env: cleanEnv,
      encoding: "utf8",
    });
    assert.equal(withCargoToml.status, 0, withCargoToml.stderr);
    assert.equal(readFileSync(envFile, "utf8"), "CARGO_BUILD_WARNINGS=deny\n");

    writeFileSync(envFile, "");
    const preset = spawnSync("bash", ["-c", script], {
      cwd: root,
      env: { ...cleanEnv, CARGO_BUILD_WARNINGS: "warn", RUST_VERSION: "1.100.0" },
      encoding: "utf8",
    });
    assert.equal(preset.status, 0, preset.stderr);
    assert.equal(readFileSync(envFile, "utf8"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
