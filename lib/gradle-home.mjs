import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A managed runner exports a persistent GRADLE_USER_HOME so that Gradle's distributions and
// dependencies outlive a job. A project that sets its own replaces it, and every run downloads
// them again. Settings belong in GRADLE_OPTS as -Dorg.gradle.*, not in a home of its own.
const ASSIGNMENT = /\bGRADLE_USER_HOME\s*[:=]/;
const COMMENT = /^\s*(#|\/\/)/;

// The tracked lines, documents aside, that set Gradle's home.
export function overrides(root) {
  const paths = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((path) => path && !/\.(md|txt)$/i.test(path));
  const found = [];
  for (const path of paths) {
    let text;
    try { text = readFileSync(join(root, path), "utf8"); }
    catch { continue; }
    if (text.includes("\0")) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (ASSIGNMENT.test(line) && !COMMENT.test(line)) found.push({ path, line: index + 1 });
    });
  }
  return found;
}
