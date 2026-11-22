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
    // mirror's build arguments; on the slot's default network a package manager can stall for
    // minutes and fetches past the cache.
    name: "image-build-flags",
    matches: (line) =>
      /\bdocker\s+(buildx\s+)?build\b|\bbuildx\s+bake\b|\bdocker\s+compose\b.*\sbuild\b/.test(line) &&
      !/NDDEV_CI_IMAGE_BUILD_FLAGS|NDDEV_CI_IMAGES|--help/.test(line),
    message:
      "This image build skips the library's builder flags, so on a managed runner its RUN steps take the slot's default network, past the package mirror. Set images: true and build with $NDDEV_CI_IMAGE_BUILD_FLAGS.",
  },
  {
    // The library's builder keeps its layers per slot for managed jobs; a local cache exported by
    // the project costs its export on every run.
    name: "local-layer-cache",
    matches: (line) => /cache-(to|from)[=:\s]+["']?type=local/.test(line),
    message:
      "A local layer cache is exported on every run, seconds for each hundred megabytes. The library's builder keeps layers per slot for managed jobs; drop it unless a measurement shows it pays.",
  },
];

const COMMENT = /^\s*(#|\/\/)/;

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
  }
  return found;
}
