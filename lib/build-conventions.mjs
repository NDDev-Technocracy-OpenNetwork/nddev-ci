import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The tracked lines that build against what a managed runner gives a job. Each is a warning with
// its remedy; none stops a merge.
export const RULES = [
  {
    // The runner exports a persistent GRADLE_USER_HOME, so Gradle's distributions and dependencies
    // outlive a job; a home of the project's own downloads them again on every run.
    name: "gradle-home",
    matches: (line) => /\bGRADLE_USER_HOME\s*[:=]/.test(line),
    message:
      "GRADLE_USER_HOME replaces the runner's persistent Gradle home, so every run downloads Gradle again. Keep the runner's home; pass settings as -Dorg.gradle.* in GRADLE_OPTS.",
  },
  {
    // A build's RUN steps reach the runner's package mirror only on the host network with the
    // mirror's build arguments; on the builder's default network a package manager can stall for
    // minutes and fetches past the cache.
    name: "image-build-flags",
    matches: (line) =>
      /\bdocker\s+(buildx\s+)?build\b|\bbuildx\s+bake\b|\bdocker\s+compose\b.*\sbuild\b/.test(line) &&
      !/NDDEV_CI_IMAGE_BUILD_FLAGS|NDDEV_CI_IMAGES|--help/.test(line),
    message:
      "This image build skips the library's builder flags, so on a managed runner its RUN steps take the builder's default network, past the package mirror. Set images: true and build with $NDDEV_CI_IMAGE_BUILD_FLAGS.",
  },
  {
    // The machine's builder shares its layers between managed jobs; a local cache exported by
    // the project costs its export on every run.
    name: "local-layer-cache",
    matches: (line) => /cache-(to|from)[=:\s]+["']?type=local/.test(line),
    message:
      "A local layer cache is exported on every run, seconds for each hundred megabytes. The machine's builder shares layers between managed jobs; drop it unless a measurement shows it pays.",
  },
  {
    // Passing -D warnings to clippy through rustc flags invalidates Cargo build caches; Cargo's
    // build.warnings config denies warnings while keeping caches shared across invocations.
    name: "clippy-deny-warnings",
    matches: (line) =>
      /\bclippy\b[^\n#]*--\s+(?:[^\n#]*\s)?(?:-D\s*warnings\b|--deny(?:=|\s+)warnings\b)/.test(line),
    message:
      "Passing -D warnings after -- to cargo clippy invalidates Cargo build caches. Set CARGO_BUILD_WARNINGS=deny instead (exported by default in CI).",
  },
];

const COMMENT = /^\s*(#|\/\/)/;

const DOCKERFILE_CHECKS = [
  {
    pattern: /\bcargo\s+(?:build|check|test|clippy|fetch|install|nextest|chef\s+cook)\b/,
    required: ["CARGO_SOURCE_CRATES_IO_REPLACE_WITH", "CARGO_SOURCE_MIRROR_REGISTRY"],
    tool: "Cargo",
  },
  {
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i|add)\b/,
    required: ["NPM_CONFIG_REGISTRY"],
    tool: "JavaScript package installation",
  },
  {
    pattern: /\bpip3?\s+install\b/,
    required: ["PIP_INDEX_URL"],
    tool: "pip",
  },
  {
    pattern: /\buv\s+(?:sync|pip\s+(?:install|sync))\b/,
    required: ["UV_DEFAULT_INDEX"],
    tool: "uv",
    ignore: /pypi-files/,
  },
  {
    pattern: /\bgo\s+(?:mod\s+download|build|test|install)\b/,
    required: ["GOPROXY"],
    tool: "Go",
  },
  {
    pattern: /\b(?:dart|flutter)\s+pub\s+get\b/,
    required: ["PUB_HOSTED_URL"],
    tool: "Pub",
  },
];

function isDockerfile(filePath) {
  const base = filePath.split("/").pop() || "";
  return base === "Dockerfile" || base.startsWith("Dockerfile.") || base.endsWith(".dockerfile");
}

function dockerfileFindings(filePath, text) {
  const rawLines = text.split(/\r?\n/);
  const instructions = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    if (COMMENT.test(rawLines[i]) || rawLines[i].trim() === "") continue;
    const startLine = i + 1;
    let combined = rawLines[i].trim();
    while (combined.endsWith("\\") && i + 1 < rawLines.length) {
      combined = combined.slice(0, -1).trimEnd();
      i += 1;
      const cont = rawLines[i].trim();
      if (!COMMENT.test(cont)) combined += " " + cont;
    }
    instructions.push({ line: startLine, text: combined });
  }

  const found = [];
  let stageArgs = new Set();
  for (const { line, text: inst } of instructions) {
    if (/^FROM\s+/i.test(inst)) {
      stageArgs = new Set();
      continue;
    }
    const argMatch = inst.match(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (argMatch) {
      stageArgs.add(argMatch[1]);
      continue;
    }
    if (!/^RUN\s+/i.test(inst)) continue;
    for (const check of DOCKERFILE_CHECKS) {
      if (!check.pattern.test(inst)) continue;
      if (check.ignore && check.ignore.test(inst)) continue;
      const missing = check.required.filter((name) => !stageArgs.has(name));
      if (missing.length > 0) {
        found.push({
          path: filePath,
          line,
          rule: "dockerfile-mirror-args",
          message: `${check.tool} in this Docker stage omits ARG ${missing.join(", ")}, so BuildKit drops the runner's mirror build arguments and fetches directly from upstream.`,
        });
      }
    }
  }
  return found;
}

// The tracked lines that break a rule, with the rule's remedy. Documents and the files of tests,
// whose build lines are fixtures, are left out.
export function findings(root) {
  const paths = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(
      (path) =>
        path && !/\.(md|txt)$/i.test(path) && !/(^|\/)(tests?|fixtures|__tests__)\//.test(path),
    );
  const found = [];
  for (const path of paths) {
    let text;
    try { text = readFileSync(join(root, path), "utf8"); }
    catch { continue; }
    if (text.includes("\0")) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (COMMENT.test(line)) return;
      for (const rule of RULES)
        if (rule.matches(line)) found.push({ path, line: index + 1, rule: rule.name, message: rule.message });
    });
    if (isDockerfile(path)) found.push(...dockerfileFindings(path, text));
  }
  return found;
}
