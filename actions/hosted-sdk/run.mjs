import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionError } from "../../lib/release-asset.mjs";
import { managedRunner } from "../../lib/runner-profile.mjs";

const names = ["node", "python", "uv", "bun", "rust", "java", "go", "flutter", "dart"];
const key = (name) => `SDK_${name.toUpperCase()}_VERSION`;

export function selections(environment) {
  managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED);
  const selected = {};
  for (const name of names) {
    const version = environment[key(name)] ?? "";
    if (version === "") continue;
    const exact = name === "java"
      ? /^[1-9][0-9]*\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?(?:\+(0|[1-9][0-9]*))?$/
      : /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
    if (!exact.test(version))
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
        !/^[a-z0-9][a-z0-9_-]*(,[a-z0-9][a-z0-9_-]*)*$/.test(value))
      throw new ActionError("Rust components and targets require a selected toolchain and comma-separated names.");
  }
  return selected;
}

// GitHub's tool cache keeps the SDKs that setup actions download from GitHub releases. One cache
// entry per exact selection, runner image and architecture lets later jobs skip those downloads.
export const toolCacheNames = Object.freeze({node: "node", python: "Python", uv: "uv", flutter: "flutter", dart: "dart"});

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
      ["flutter", "dart"].includes(name) ? `${selected[name]}-${process.arch}` : selected[name])),
  };
}

/** Measures Java release/build identity in the selected SDK spelling. */
export function javaVersion(text, requested) {
  const canonical = (value) => /^[1-9][0-9]*(?:\.(?:0|[1-9][0-9]*)){0,3}$/.test(value ?? "")
    ? value.replace(/(?:\.0)+$/, "") : undefined;
  const version = text.match(/^openjdk ([0-9][^\s]*)(?: |$)/m)?.[1];
  const actual = canonical(version), release = requested.split("+")[0];
  if (!actual) return undefined;
  // Runtime.Version omits trailing zero release fields; the SDK keeps its exact input tuple.
  if (!requested.includes("+")) return actual === canonical(release) ? requested : version;
  const runtime = text.match(/^OpenJDK Runtime Environment[^\r\n]*\(build ([^)\s]+)\)/m)?.[1]
    ?.replace(/-LTS$/, "");
  const parts = runtime?.match(/^([0-9.]+)\+(0|[1-9][0-9]*)$/);
  if (!parts || canonical(parts[1]) !== actual) return undefined;
  return actual === canonical(release) ? release + "+" + parts[2] : runtime;
}

function measure(name, environment, executable) {
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
  const command = executable ?? ({rust: "rustc", java: "java"}[name] ?? name);
  const args = name === "go" ? ["version"] : ["--version"];
  const result = spawnSync(command, args, {
    env: environment, encoding: "utf8", timeout: 30000, maxBuffer: 65536, windowsHide: true,
  });
  if (result.error || result.status !== 0) return {};
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (name === "java") return {java: javaVersion(text, environment.SDK_JAVA_VERSION)};
  const expression = {
    node: /^v([^\s]+)$/m,
    bun: /^([^\s]+)$/m,
    rust: /^rustc ([^\s]+)(?: |$)/m,
    python: /^Python ([^\s]+)(?: |$)/m,
    uv: /^uv ([^\s]+)(?: |$)/m,
    go: /^go version go([^\s]+) /m,
    dart: /^Dart SDK version: ([^\s]+) \(stable\)(?: |$)/m,
  }[name];
  return {[name]: text.match(expression)?.[1]};
}

// Node and Bun select their requested line from the managed tool cache. Older runner
// images may supply Bun on PATH, which must still pass the same version check.
function managedRuntime(environment, name, version) {
  if (!version || !managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED)) return null;
  const root = environment.RUNNER_TOOL_CACHE ?? "";
  if (!path.isAbsolute(root) || /[\r\n\0]/.test(root))
    throw new ActionError("The managed RUNNER_TOOL_CACHE must be an absolute path.");
  const folder = path.join(root, name, version, process.arch);
  const bin = name === "node" ? path.join(folder, "bin") : folder;
  const executable = path.join(bin, process.platform === "win32" ? name + ".exe" : name);
  if (name === "bun" && !existsSync(executable)) return null;
  return {bin, executable};
}

// A managed SDK keeps every Python line of the registry where uv finds its own installations,
// UV_PYTHON_INSTALL_DIR, one folder per version named cpython-<version>-<system>, and puts none of
// them on PATH. The selected line's folder becomes the first PATH entry and uv's interpreter. A
// folder without that line leaves PATH as it is, and the measurement below decides.
export function managedPython(environment, platform = process.platform, list = readdirSync) {
  const version = environment.SDK_PYTHON_VERSION ?? "";
  const root = environment.UV_PYTHON_INSTALL_DIR ?? "";
  if (version === "" || root === "" ||
      !managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED)) return null;
  if (!path.isAbsolute(root) || /[\r\n]/.test(root))
    throw new ActionError("The managed UV_PYTHON_INSTALL_DIR must be an absolute path.");
  const prefix = `cpython-${version}-`;
  let folders;
  try {
    folders = list(root, {withFileTypes: true})
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) &&
        /^[a-z0-9_]+(-[a-z0-9_]+)+$/.test(entry.name.slice(prefix.length)))
      .map((entry) => entry.name);
  } catch { folders = []; }
  if (!folders.length) return null;
  if (folders.length > 1)
    throw new ActionError(`The managed SDK holds more than one Python ${version}: ${folders.join(", ")}.`);
  const folder = path.join(root, folders[0]);
  const bin = platform === "win32" ? folder : path.join(folder, "bin");
  return {bin, executable: path.join(bin, platform === "win32" ? "python.exe" : "python")};
}

// A managed SDK keeps each registry line of a declared tool in its own tool-cache folder,
// <tool>/<version>/<architecture>, so two lines can stand side by side while projects move from
// one to the other. The declared line's folder goes first on PATH; a missing folder leaves PATH as
// it is, and the measurement below decides.
export function managedTools(environment, exists = existsSync) {
  const tools = (environment.SDK_TOOLS || "").split(",").filter(Boolean);
  if (!tools.length || !managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED)) return [];
  const root = environment.RUNNER_TOOL_CACHE ?? "";
  if (!path.isAbsolute(root) || /[\r\n\0]/.test(root))
    throw new ActionError("The managed RUNNER_TOOL_CACHE must be an absolute path.");
  return tools.map((tool) => path.join(root, ...tool.split("@"), process.arch)).filter((folder) => exists(folder));
}

function verifyRust(environment, toolchain) {
  const components = (environment.SDK_RUST_COMPONENTS || "").split(",").filter(Boolean);
  const targets = (environment.SDK_RUST_TARGETS || "").split(",").filter(Boolean);
  if (!components.length && !targets.length) return;
  function inspect(command, args) {
    const result = spawnSync(command, args, {
      env: environment, encoding: "utf8", timeout: 30000, maxBuffer: 65536, windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw new ActionError("Cannot inspect the requested Rust capabilities for toolchain " + toolchain + ".");
    return result.stdout.trim();
  }
  const host = inspect("rustc", ["-vV"]).match(/^host: ([a-z0-9_-]+)$/m)?.[1];
  if (!host)
    throw new ActionError("Cannot determine the Rust host for toolchain " + toolchain + ".");
  for (const [kind, requested] of [["component", components], ["target", targets]]) {
    if (!requested.length) continue;
    const installed = new Set(inspect("rustup", [
      kind, "list", "--installed", "--quiet", "--toolchain", toolchain + "-" + host,
    ]).split(/\r?\n/));
    for (const name of requested)
      if (!installed.has(name) && !(kind === "component" && installed.has(name + "-" + host)))
        throw new ActionError("The selected Rust toolchain " + toolchain + " is missing requested " + kind + " " + name + ".");
  }
}

function prependPath(environment, bin) {
  // Match Node's case-insensitive subprocess environment ordering on Windows.
  const name = process.platform === "win32"
    ? Object.keys(environment).sort().find((key) => key.toUpperCase() === "PATH") ?? "PATH"
    : "PATH";
  return {...environment, [name]: [bin, environment[name]].filter(Boolean).join(path.delimiter)};
}

function verifiedSelection(environment) {
  const selected = selections(environment);
  supported(selected);
  const node = managedRuntime(environment, "node", selected.node);
  if (node) environment = prependPath(environment, node.bin);
  const bun = managedRuntime(environment, "bun", selected.bun);
  if (bun) environment = prependPath(environment, bun.bin);
  // Verification must not let rustup install a missing toolchain through a compiler proxy.
  if (selected.rust) environment = {...environment, RUSTUP_AUTO_INSTALL: "0"};
  const versions = {};
  for (const [name, expected] of Object.entries(selected)) {
    const executable = name === "node" ? node?.executable : name === "bun" ? bun?.executable : undefined;
    const measured = measure(name, environment, executable);
    if (measured[name] !== expected)
      throw new ActionError(`The selected ${name} executable does not provide version ${expected}.`);
    Object.assign(versions, measured);
  }
  if (selected.rust) verifyRust(environment, selected.rust);
  const folders = managedTools(environment);
  for (const folder of [...folders].reverse()) environment = prependPath(environment, folder);
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
  return {node, bun, folders, receipt: {schema_version: 1, platform: process.platform, architecture: process.arch, versions, tools}};
}

export function verify(environment) {
  return verifiedSelection(environment).receipt;
}

function selectionPayload(environment) {
  const fields = [
    "SDK_RUNNER_ENVIRONMENT",
    "SDK_MANAGED",
    "SDK_TOOLS",
    "SDK_RUST_COMPONENTS",
    "SDK_RUST_TARGETS",
    ...names.map(key),
  ];
  return Object.fromEntries(
    fields.filter((field) => (environment[field] ?? "") !== "").map((field) => [field, environment[field]]),
  );
}

function mergeSelection(environment) {
  if (!environment.SDK_SELECTION) return environment;
  let parsed;
  try {
    parsed = JSON.parse(environment.SDK_SELECTION);
  } catch {
    throw new ActionError("The validated SDK selection is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ActionError("The validated SDK selection is invalid.");
  return { ...parsed, ...environment };
}

export function main(mode, environment = process.env) {
  if (mode === "validate") {
    supported(selections(environment));
    const plan = cachePlan(environment);
    const selection = JSON.stringify(selectionPayload(environment));
    if (environment.GITHUB_OUTPUT)
      appendFileSync(environment.GITHUB_OUTPUT,
        `bootstrap=${!managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED)}\ncache-key=${plan.key}\nselection=${selection}\ncache-paths<<NDDEV_SDK_PATHS\n${plan.paths.join("\n")}\nNDDEV_SDK_PATHS\n`);
    return;
  }
  if (mode !== "verify") throw new ActionError("Unknown hosted SDK command.");
  environment = mergeSelection(environment);
  selections(environment);
  const python = managedPython(environment);
  const {node, bun, folders, receipt} = verifiedSelection(python ? prependPath(environment, python.bin) : environment);
  const variables = {BUN_DO_NOT_TRACK: "1", DO_NOT_TRACK: "1"};
  if (python) variables.UV_PYTHON = python.executable;
  // GitHub prepends each entry. Keep the verified directories ahead of the default SDK bin.
  const paths = [python?.bin, node?.bin, bun?.bin, ...folders].filter(Boolean);
  if (paths.length && environment.GITHUB_PATH)
    appendFileSync(environment.GITHUB_PATH, paths.join("\n") + "\n");
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
