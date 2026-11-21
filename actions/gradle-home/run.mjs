import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { overrides } from "../../lib/gradle-home.mjs";

export function main(environment = process.env, log = console.log) {
  const found = overrides(realpathSync(environment.GITHUB_WORKSPACE));
  for (const { path: file, line } of found)
    log(`::warning file=${file},line=${line}::GRADLE_USER_HOME replaces the runner's persistent Gradle home, so every run downloads Gradle again. Keep the runner's home; pass settings as -Dorg.gradle.* in GRADLE_OPTS.`);
  if (!found.length) log("No tracked file sets Gradle's home.");
  return found.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { console.error("::warning::Gradle's home was not read: " + String(error.message)); }
}
