import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registry } from "../artifact-registry/run.mjs";
import { ActionError } from "../../lib/release-asset.mjs";

const loader = "def script = System.getenv('NDDEV_GRADLE_MIRROR_INIT')\nif (script) apply from: script\n";

export function wrapDistribution(properties, mirror) {
  const urls = [...properties.matchAll(/^([ \t]*distributionUrl[ \t]*[=:][ \t]*)([^\r\n]+)$/gm)];
  if (urls.length !== 1)
    throw new ActionError("The Gradle Wrapper must declare one distributionUrl.");
  const [line, prefix, value] = urls[0];
  const original = value.trim().replace(/\\:/g, ":");
  const distribution = original.match(/^https:\/\/(?:services|downloads)\.gradle\.org\/distributions\/(gradle-[0-9][\w.-]*-(?:bin|all)\.zip)$/);
  if (!distribution) return properties;
  const checksums = [...properties.matchAll(/^[ \t]*distributionSha256Sum[ \t]*[=:][ \t]*([a-fA-F0-9]{64})[ \t]*$/gm)];
  if (checksums.length !== 1)
    throw new ActionError("The official Gradle distribution requires one checked-in distributionSha256Sum.");
  const replacement = `${mirror}/gradle/distributions/${distribution[1]}`.replace(":", "\\:");
  return properties.slice(0, urls[0].index) + prefix + replacement + properties.slice(urls[0].index + line.length);
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function initLoader(home) {
  const parent = path.join(home, "init.d");
  const file = path.join(parent, "nddev-ci-mirror.init.gradle");
  mkdirSync(parent, { recursive: true });
  if (existsSync(file)) {
    if (readFileSync(file, "utf8") !== loader)
      throw new ActionError("The shared Gradle mirror init loader has unexpected contents.");
    return;
  }
  const temporary = mkdtempSync(path.join(parent, ".nddev-init-"));
  try {
    const staged = path.join(temporary, "loader");
    writeFileSync(staged, loader);
    renameSync(staged, file);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function main(environment = process.env) {
  if (environment.RUNNER_ENVIRONMENT !== "self-hosted") return;
  const mirror = registry(environment);
  if (!mirror) return;

  const workspace = realpathSync(environment.GITHUB_WORKSPACE);
  const file = realpathSync(path.resolve(workspace, environment["INPUT_WORKING-DIRECTORY"] || ".", "gradle/wrapper/gradle-wrapper.properties"));
  if (!inside(workspace, file))
    throw new ActionError("The Gradle Wrapper must be inside the checkout.");
  const before = readFileSync(file, "utf8");
  const after = wrapDistribution(before, mirror);

  const home = path.resolve(environment.GRADLE_USER_HOME || path.join(homedir(), ".gradle"));
  initLoader(home);
  if (before !== after) {
    const directory = mkdtempSync(path.join(environment.RUNNER_TEMP, "nddev-gradle-wrapper-"));
    writeFileSync(path.join(directory, "wrapper.json"), JSON.stringify({ file, before, after }), { mode: 0o600 });
    appendFileSync(environment.GITHUB_STATE, `gradle_wrapper_directory=${directory}\n`);
    writeFileSync(file, after);
  }
  const script = fileURLToPath(new URL("./mirror.gradle", import.meta.url));
  appendFileSync(environment.GITHUB_ENV, `NDDEV_GRADLE_MIRROR_INIT=${script}\nNDDEV_GRADLE_MIRROR_URL=${mirror}\n`);
  console.log("Gradle uses the runner's artifact registry for supported public repositories.");
}

export function cleanup(environment = process.env) {
  const directory = environment.STATE_gradle_wrapper_directory;
  if (!directory) return;
  if (path.dirname(directory) !== path.resolve(environment.RUNNER_TEMP) ||
      !/^nddev-gradle-wrapper-[A-Za-z0-9]+$/.test(path.basename(directory)))
    throw new ActionError("Gradle Wrapper cleanup escaped its job directory.");
  const record = path.join(directory, "wrapper.json");
  const { file, before, after } = JSON.parse(readFileSync(record, "utf8"));
  try {
    if (existsSync(file) && inside(realpathSync(environment.GITHUB_WORKSPACE), realpathSync(file)) &&
        readFileSync(file, "utf8") === after) {
      writeFileSync(file, before);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
