import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionError } from "../../lib/release-asset.mjs";
import { managedRunner } from "../../lib/runner-profile.mjs";

const names = ["node", "python", "uv", "bun", "rust", "java", "go", "flutter"];
const key = (name) => `SDK_${name.toUpperCase()}_VERSION`;

export function selections(environment) {
  managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED);
  const selected = {};
  for (const name of names) {
    const version = environment[key(name)] ?? "";
    if (version === "") continue;
    if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version))
      throw new ActionError(`The ${name} selection must be an exact stable version.`);
    selected[name] = version;
  }
  const tools = environment.SDK_TOOLS ?? "";
  if (tools !== "") {
    const exact = "[a-z0-9][a-z0-9-]*@(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)";
    const names = tools.split(",").map((tool) => tool.split("@")[0]);
    if (tools.length > 1024 || !new RegExp(`^${exact}(,${exact})*$`).test(tools) || new Set(names).size !== names.length)
      throw new ActionError("Tools must be comma-separated name@exact-version entries, each name once.");
  }
  for (const name of ["COMPONENTS", "TARGETS"]) {
    const value = environment[`SDK_RUST_${name}`] ?? "";
    if (value === "") continue;
    if (!selected.rust || value.length > 1024 ||
        !/^[a-z0-9][a-z0-9-]*(,[a-z0-9][a-z0-9-]*)*$/.test(value))
      throw new ActionError("Rust components and targets require a selected toolchain and comma-separated names.");
  }
  return selected;
}

// GitHub's tool cache keeps the SDKs that setup actions download from GitHub releases. One cache
// entry per exact selection, runner image and architecture lets later jobs skip those downloads.
export const toolCacheNames = Object.freeze({node: "node", python: "Python", uv: "uv", flutter: "flutter"});

// Flutter publishes its SDK for Linux and Windows on x64 only, and for macOS on x64 and ARM64.
// Temurin publishes no JDK for Windows on ARM64.
export function supported(selected, platform = process.platform, arch = process.arch) {
  if (selected.flutter && platform !== "darwin" && arch !== "x64")
    throw new ActionError("Flutter publishes no SDK for this system and architecture; select an x64 runner.");
  if (selected.java && platform === "win32" && arch === "arm64")
    throw new ActionError("Temurin publishes no JDK for Windows on ARM64; select another runner.");
}

// The runner image's operating system release, which decides the native SDK builds: ImageOS where
// the image sets it, otherwise the system's own release (some ARM64 and Windows images lack it).
export function imageKey(environment, platform = process.platform, readRelease = () => readFileSync("/etc/os-release", "utf8"), release = os.release()) {
  const declared = environment.ImageOS ?? "";
  if (/^[a-z0-9]{1,32}$/.test(declared)) return declared;
  let key = "";
  if (platform === "linux") {
    const fields = Object.fromEntries(readRelease().split("\n").map((line) => line.split("=")).filter((pair) => pair.length === 2)
      .map(([name, value]) => [name, value.replace(/^"|"$/g, "")]));
    key = `${fields.ID ?? ""}${fields.VERSION_ID ?? ""}`;
  } else if (platform === "darwin") key = `darwin${release.split(".")[0]}`;
  else if (platform === "win32") key = `win${release.split(".")[2] ?? ""}`;
  key = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!/^[a-z0-9]{2,32}$/.test(key)) throw new ActionError("The hosted runner image is unknown.");
  return key;
}

// The macOS Python build installs its framework under /Library/Frameworks and leaves only links in
// the tool cache, so a restored copy would be broken there; it is prepared fresh instead.
export function cachePlan(environment, platform = process.platform) {
  const selected = selections(environment);
  if (managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED)) return {key: "", paths: []};
  const root = environment.RUNNER_TOOL_CACHE;
  const parts = Object.keys(toolCacheNames).filter((name) => selected[name] &&
    !(name === "python" && platform === "darwin"));
  if (!parts.length) return {key: "", paths: []};
  if (!root || /[\r\n]/.test(root)) throw new ActionError("The runner tool cache is required.");
  const image = imageKey(environment);
  return {
    key: ["nddev-sdk-v1", image, environment.RUNNER_ARCH ?? process.arch,
      ...parts.map((name) => `${name}-${selected[name]}`)].join("-"),
    paths: parts.map((name) => path.join(root, toolCacheNames[name],
      name === "flutter" ? `${selected[name]}-${process.arch}` : selected[name])),
  };
}

function measure(name, environment) {
  if (name === "flutter") {
    const result = spawnSync("flutter", ["--version", "--machine"], {
      env: environment, encoding: "utf8", timeout: 300000, maxBuffer: 1048576,
      windowsHide: true, shell: process.platform === "win32",
    });
    if (result.error || result.status !== 0) return {};
    try {
      const document = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
      return {flutter: document.frameworkVersion, dart: document.dartSdkVersion?.split(" ")[0]};
    } catch { return {}; }
  }
  const command = {rust: "rustc", java: "java"}[name] ?? name;
  const args = name === "go" ? ["version"] : ["--version"];
  const result = spawnSync(command, args, {
    env: environment, encoding: "utf8", timeout: 30000, maxBuffer: 65536, windowsHide: true,
  });
  if (result.error || result.status !== 0) return {};
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const expression = {
    node: /^v([^\s]+)$/m,
    bun: /^([^\s]+)$/m,
    rust: /^rustc ([^\s]+)(?: |$)/m,
    python: /^Python ([^\s]+)(?: |$)/m,
    uv: /^uv ([^\s]+)(?: |$)/m,
    java: /^openjdk ([0-9][^\s]*)(?: |$)/m,
    go: /^go version go([^\s]+) /m,
  }[name];
  return {[name]: text.match(expression)?.[1]};
}

export function verify(environment) {
  const selected = selections(environment);
  supported(selected);
  const versions = {};
  for (const [name, expected] of Object.entries(selected)) {
    const measured = measure(name, environment);
    if (measured[name] !== expected)
      throw new ActionError(`The selected ${name} executable does not provide version ${expected}.`);
    Object.assign(versions, measured);
  }
  const tools = {};
  for (const selection of (environment.SDK_TOOLS || "").split(",").filter(Boolean)) {
    const [name, expected] = selection.split("@");
    const result = spawnSync(name, ["--version"], {
      env: environment, encoding: "utf8", timeout: 30000, maxBuffer: 65536, windowsHide: true,
    });
    const measured = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
    if (result.error || result.status !== 0 || measured !== expected)
      throw new ActionError(`The selected ${name} executable does not provide version ${expected}.`);
    tools[name] = measured;
  }
  return {schema_version: 1, platform: process.platform, architecture: process.arch, versions, tools};
}

export function main(mode, environment = process.env) {
  if (mode === "validate") {
    supported(selections(environment));
    const plan = cachePlan(environment);
    if (environment.GITHUB_OUTPUT)
      appendFileSync(environment.GITHUB_OUTPUT,
        `bootstrap=${!managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED)}\ncache-key=${plan.key}\ncache-paths<<NDDEV_SDK_PATHS\n${plan.paths.join("\n")}\nNDDEV_SDK_PATHS\n`);
    return;
  }
  if (mode !== "verify") throw new ActionError("Unknown hosted SDK command.");
  const receipt = verify(environment);
  const variables = {BUN_DO_NOT_TRACK: "1", DO_NOT_TRACK: "1"};
  if (receipt.versions.uv && !managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED)) {
    if (!environment.RUNNER_TEMP || /[\r\n]/.test(environment.RUNNER_TEMP))
      throw new ActionError("A runner temporary directory is required.");
    variables.UV_CACHE_DIR = path.join(environment.RUNNER_TEMP, "uv-cache");
    variables.UV_PROJECT_ENVIRONMENT = path.join(environment.RUNNER_TEMP, "project-environment");
    if (receipt.versions.python) {
      if (!environment.SDK_PYTHON_PATH || /[\r\n]/.test(environment.SDK_PYTHON_PATH))
        throw new ActionError("The selected Python action must provide its executable path.");
      variables.UV_PYTHON = environment.SDK_PYTHON_PATH;
    }
  }
  if (environment.GITHUB_ENV)
    appendFileSync(environment.GITHUB_ENV, Object.entries(variables).map(([k, v]) => `${k}=${v}\n`).join(""));
  const document = JSON.stringify(receipt);
  if (environment.GITHUB_OUTPUT)
    appendFileSync(environment.GITHUB_OUTPUT, `receipt=${document}\n`);
  console.log(document);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try { main(process.argv[2]); }
  catch (error) {
    console.error(`::error::${error instanceof ActionError ? error.message : "Hosted SDK verification failed."}`);
    process.exitCode = 1;
  }
