import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadRegistrySnapshot, resolveTool, resolveToolchain } from "../../lib/registry-resolve.mjs";
import { ActionError } from "../../lib/release-asset.mjs";
import { managedRunner } from "../../lib/runner-profile.mjs";
import {
  androidCachePaths,
  androidComponents,
  androidDefaultComponents,
  normalizeAndroidComponent,
  parseAndroidSdkSpec,
  verifyAndroidSdk,
} from "./android.mjs";

const names = ["node", "python", "uv", "bun", "rust", "java", "go", "flutter", "dart", "dotnet", "ruby"];
const toolExecutables = Object.freeze({
  maven: "mvn",
  "bats-core": "bats",
  "sqlx-cli": "sqlx",
  "wasm-bindgen-cli": "wasm-bindgen",
  compose: "docker-compose",
});
const key = (name) => `SDK_${name.toUpperCase()}_VERSION`;
const bareNamePattern = /^[a-z0-9][a-z0-9-]*$/;
const exactSemverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const exactJavaPattern = /^[1-9][0-9]*\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?(?:\+(0|[1-9][0-9]*))?$/;

function resolveToolsList(rawTools, snapshot) {
  if (rawTools === "") return "";
  if (rawTools.length > 1024) {
    throw new ActionError("Tools must be comma-separated name@exact-version entries, each name once.");
  }
  const seen = new Set();
  const resolved = [];
  for (const entry of rawTools.split(",")) {
    if (!entry) {
      throw new ActionError("Tools must be comma-separated name@exact-version entries, each name once.");
    }
    const at = entry.indexOf("@");
    if (at === -1) {
      if (!snapshot || !bareNamePattern.test(entry)) {
        throw new ActionError("Tools must be comma-separated name@exact-version entries, each name once.");
      }
      if (seen.has(entry)) {
        throw new ActionError("Tools must be comma-separated name@exact-version entries, each name once.");
      }
      seen.add(entry);
      const version = resolveTool(snapshot, entry).version;
      if (!exactSemverPattern.test(version)) {
        throw new ActionError(`Resolved tool ${entry} version ${version} is not an exact stable version.`);
      }
      resolved.push(`${entry}@${version}`);
      continue;
    }
    const name = entry.slice(0, at);
    const version = entry.slice(at + 1);
    if (!bareNamePattern.test(name) || !exactSemverPattern.test(version) || seen.has(name)) {
      throw new ActionError("Tools must be comma-separated name@exact-version entries, each name once.");
    }
    seen.add(name);
    if (snapshot) resolveTool(snapshot, name, version);
    resolved.push(`${name}@${version}`);
  }
  return resolved.join(",");
}

export function resolveSelectionEnvironment(environment) {
  managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED);
  const snapshot = loadRegistrySnapshot(environment);
  const resolvedEnv = { ...environment };
  const selected = {};

  const requestedToolchains = (environment.SDK_TOOLCHAINS ?? "").trim();
  const requestedAndroidFromToolchains = [];
  if (requestedToolchains !== "") {
    if (!snapshot) {
      throw new ActionError("Selecting toolchains by registry name requires NDDEV_CI_REGISTRY_SNAPSHOT.");
    }
    const seen = new Set();
    for (const item of requestedToolchains.split(",")) {
      const name = item.trim();
      if (!name || seen.has(name)) {
        throw new ActionError(`Unknown or duplicate toolchain selection: ${JSON.stringify(item)}.`);
      }
      if (name === "android") {
        seen.add(name);
        for (const component of androidDefaultComponents) requestedAndroidFromToolchains.push(component);
        continue;
      }
      if (name.startsWith("android-")) {
        const component = normalizeAndroidComponent(name);
        if (!component) {
          throw new ActionError(`Unknown or duplicate toolchain selection: ${JSON.stringify(item)}.`);
        }
        seen.add(name);
        requestedAndroidFromToolchains.push(component);
        continue;
      }
      if (!names.includes(name)) {
        throw new ActionError(`Unknown or duplicate toolchain selection: ${JSON.stringify(item)}.`);
      }
      seen.add(name);
      if ((resolvedEnv[key(name)] ?? "") === "") {
        resolvedEnv[key(name)] = resolveToolchain(snapshot, name).version;
      }
    }
  }

  for (const name of names) {
    const version = resolvedEnv[key(name)] ?? "";
    if (version === "") continue;
    const exact = name === "java" ? exactJavaPattern : exactSemverPattern;
    if (!exact.test(version))
      throw new ActionError(`The ${name} selection must be an exact stable version.`);
    if (snapshot) resolveToolchain(snapshot, name, version);
    selected[name] = version;
  }

  let android = parseAndroidSdkSpec(environment.SDK_ANDROID_SDK ?? "", snapshot);
  if (requestedAndroidFromToolchains.length > 0) {
    const combined = android.entries.map((entry) => `${entry.name}@${entry.version}`);
    const present = new Set(android.entries.map((entry) => entry.name));
    for (const component of requestedAndroidFromToolchains) {
      if (present.has(component)) continue;
      present.add(component);
      const version = resolveToolchain(snapshot, androidComponents[component].registryKey).version;
      combined.push(`${component}@${version}`);
    }
    android = parseAndroidSdkSpec(combined.join(","), snapshot);
  }
  if (android.normalized !== "") resolvedEnv.SDK_ANDROID_SDK = android.normalized;

  const tools = resolveToolsList(environment.SDK_TOOLS ?? "", snapshot);
  if (tools !== "") resolvedEnv.SDK_TOOLS = tools;

  for (const name of ["COMPONENTS", "TARGETS"]) {
    const value = environment[`SDK_RUST_${name}`] ?? "";
    if (value === "") continue;
    if (!selected.rust || value.length > 1024 ||
        !/^[a-z0-9][a-z0-9_-]*(,[a-z0-9][a-z0-9_-]*)*$/.test(value))
      throw new ActionError("Rust components and targets require a selected toolchain and comma-separated names.");
  }
  return { selected, resolvedEnv, tools, android };
}

export function selections(environment) {
  return resolveSelectionEnvironment(environment).selected;
}

// GitHub's tool cache keeps the SDKs that setup actions download from GitHub releases. One cache
// entry per exact selection, runner image and architecture lets later jobs skip those downloads.
export const toolCacheNames = Object.freeze({node: "node", python: "Python", uv: "uv", flutter: "flutter", dart: "dart"});

// Flutter and Android SDK publish Linux and Windows host binaries for x64 only, and macOS for x64 and ARM64.
// Temurin publishes no JDK for Windows on ARM64.
export function supported(selected, platform = process.platform, arch = process.arch, androidEntries = []) {
  if (selected.flutter && platform !== "darwin" && arch !== "x64")
    throw new ActionError("Flutter publishes no SDK for this system and architecture; select an x64 runner.");
  if (androidEntries.length > 0 && platform !== "darwin" && arch !== "x64")
    throw new ActionError("Android SDK publishes no host binaries for this system and architecture; select an x64 or macOS runner.");
  if (selected.java && platform === "win32" && arch === "arm64")
    throw new ActionError("Temurin publishes no JDK for Windows on ARM64; select another runner.");
}

// The runner image's operating system release, which decides the native SDK builds: ImageOS where
// the image sets it, otherwise the system's own release (some ARM64 and Windows images lack it).
export function imageKey(environment, platform = process.platform, readRelease = () => readFileSync("/etc/os-release", "utf8"), release = os.release()) {
  const declared = environment.ImageOS ?? "";
  if (/^[a-z0-9]{1,32}$/.test(declared)) return declared;
  let keyName = "";
  if (platform === "linux") {
    const fields = Object.fromEntries(readRelease().split("\n").map((line) => line.split("=")).filter((pair) => pair.length === 2)
      .map(([name, value]) => [name, value.replace(/^"|"$/g, "")]));
    keyName = `${fields.ID ?? ""}${fields.VERSION_ID ?? ""}`;
  } else if (platform === "darwin") keyName = `darwin${release.split(".")[0]}`;
  else if (platform === "win32") keyName = `win${release.split(".")[2] ?? ""}`;
  keyName = keyName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!/^[a-z0-9]{2,32}$/.test(keyName)) throw new ActionError("The hosted runner image is unknown.");
  return keyName;
}

// The macOS Python build installs its framework under /Library/Frameworks and leaves only links in
// the tool cache, so a restored copy would be broken there; it is prepared fresh instead.
export function cachePlan(environment, platform = process.platform) {
  const { selected, android } = resolveSelectionEnvironment(environment);
  if (managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED)) return {key: "", paths: []};
  const root = environment.RUNNER_TOOL_CACHE;
  const parts = Object.keys(toolCacheNames).filter((name) => selected[name] &&
    !(name === "python" && platform === "darwin"));
  if (!parts.length && !android.entries.length) return {key: "", paths: []};
  if (!root || /[\r\n]/.test(root)) throw new ActionError("The runner tool cache is required.");
  const image = imageKey(environment);
  const androidKeyParts = [...android.entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `android-${entry.name}-${entry.version}`);
  return {
    key: ["nddev-sdk-v1", image, environment.RUNNER_ARCH ?? process.arch,
      ...parts.map((name) => `${name}-${selected[name]}`),
      ...androidKeyParts].join("-"),
    paths: [
      ...parts.map((name) => path.join(root, toolCacheNames[name],
        ["flutter", "dart"].includes(name) ? `${selected[name]}-${process.arch}` : selected[name])),
      ...androidCachePaths(root, android.entries),
    ],
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
    const result = spawnSync(executable ?? "flutter", ["--version", "--machine"], {
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
    dotnet: /^([0-9]+\.[0-9]+\.[0-9]+)$/m,
    ruby: /^ruby ([0-9]+\.[0-9]+\.[0-9]+)(?:p\d+)?(?: |$)/m,
  }[name];
  return {[name]: text.match(expression)?.[1]};
}

function runtimeArchCandidates(arch = process.arch) {
  if (arch === "x64") return ["x64", "x86_64"];
  if (arch === "arm64") return ["arm64", "aarch64"];
  return [arch];
}

// Managed toolchains select their requested line from the managed tool cache when installed there.
// Node always requires its exact tool-cache entry; other runtimes fall back to verified PATH entries.
function managedRuntime(environment, name, version) {
  if (!version || !managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED)) return null;
  const root = environment.RUNNER_TOOL_CACHE ?? "";
  if (!root && !["node", "bun"].includes(name)) return null;
  if (!path.isAbsolute(root) || /[\r\n\0]/.test(root))
    throw new ActionError("The managed RUNNER_TOOL_CACHE must be an absolute path.");
  const exeName = process.platform === "win32" ? `${name}.exe` : name;
  if (name === "node") {
    const bin = path.join(root, "node", version, process.arch, "bin");
    return { bin, executable: path.join(bin, exeName) };
  }
  const arches = runtimeArchCandidates();
  const candidates = [];
  if (name === "bun") {
    candidates.push({ bin: path.join(root, "bun", version, process.arch) });
  } else if (name === "java") {
    const baseVersion = version.split("+")[0];
    for (const ver of new Set([version, baseVersion])) {
      for (const dir of ["Java_Temurin-Hotspot_jdk", "jdk"]) {
        for (const arch of arches) {
          const home = path.join(root, dir, ver, arch);
          candidates.push({ bin: path.join(home, "bin"), env: { JAVA_HOME: home } });
        }
      }
    }
  } else if (name === "uv") {
    for (const arch of arches) {
      const folder = path.join(root, "uv", version, arch);
      candidates.push({ bin: folder }, { bin: path.join(folder, "bin") });
    }
  } else if (name === "flutter") {
    for (const dir of [`stable-${version}-${process.arch}`, `${version}-${process.arch}`]) {
      const home = path.join(root, "flutter", dir, "flutter");
      candidates.push({ bin: path.join(home, "bin"), env: { FLUTTER_ROOT: home } });
    }
    const folder = path.join(root, "flutter", version, process.arch);
    candidates.push({ bin: path.join(folder, "bin") }, { bin: folder });
  } else if (name === "dart") {
    candidates.push(
      { bin: path.join(root, "dart", `${version}-${process.arch}`, "dart-sdk", "bin") },
      { bin: path.join(root, "dart", version, process.arch, "bin") },
      { bin: path.join(root, "dart", version, process.arch) },
    );
  } else {
    for (const arch of arches) {
      const folder = path.join(root, name, version, arch);
      candidates.push({ bin: path.join(folder, "bin") }, { bin: folder });
    }
  }
  for (const candidate of candidates) {
    const executable = path.join(candidate.bin, exeName);
    if (existsSync(executable)) return { ...candidate, executable };
  }
  return null;
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
  const dirs = [];
  for (const tool of tools) {
    const base = path.join(root, ...tool.split("@"), process.arch);
    const bin = path.join(base, "bin");
    if (exists(bin)) dirs.push(bin);
    else if (exists(base)) dirs.push(base);
  }
  return dirs;
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
    ? Object.keys(environment).sort().find((keyName) => keyName.toUpperCase() === "PATH") ?? "PATH"
    : "PATH";
  return {...environment, [name]: [bin, environment[name]].filter(Boolean).join(path.delimiter)};
}

function verifiedSelection(environment) {
  const { selected, resolvedEnv, android } = resolveSelectionEnvironment(environment);
  environment = resolvedEnv;
  supported(selected, process.platform, process.arch, android.entries);
  const isManaged = managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED);
  const runtimes = {};
  const runtimeEnv = {};
  for (const runtimeName of ["node", "bun", "uv", "go", "java", "dart", "flutter", "dotnet", "ruby"]) {
    const found = managedRuntime(environment, runtimeName, selected[runtimeName]);
    if (found) {
      runtimes[runtimeName] = found;
      environment = prependPath(environment, found.bin);
      if (found.env) {
        Object.assign(runtimeEnv, found.env);
        environment = { ...environment, ...found.env };
      }
    }
  }
  const androidVerified = verifyAndroidSdk(environment, android.entries, isManaged);
  if (androidVerified.androidHome) {
    runtimeEnv.ANDROID_HOME = androidVerified.androidHome;
    runtimeEnv.ANDROID_SDK_ROOT = androidVerified.androidHome;
    environment = { ...environment, ANDROID_HOME: androidVerified.androidHome, ANDROID_SDK_ROOT: androidVerified.androidHome };
    for (const bin of [...androidVerified.bins].reverse()) environment = prependPath(environment, bin);
  }
  // Verification must not let rustup install a missing toolchain through a compiler proxy.
  if (selected.rust) {
    environment = {...environment, RUSTUP_AUTO_INSTALL: "0"};
    if (isManaged && !environment.RUSTUP_TOOLCHAIN) {
      runtimeEnv.RUSTUP_TOOLCHAIN = selected.rust;
      environment = { ...environment, RUSTUP_TOOLCHAIN: selected.rust };
    }
  }
  const versions = {};
  for (const [name, expected] of Object.entries(selected)) {
    const executable = runtimes[name]?.executable;
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
    const command = toolExecutables[name] ?? name;
    const result = spawnSync(command, ["--version"], {
      env: environment, encoding: "utf8", timeout: 30000, maxBuffer: 65536, windowsHide: true,
    });
    const measured = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/(?:^|[\s:])v?(\d+\.\d+\.\d+)(?:[\s,)-]|$)/)?.[1];
    if (result.error || result.status !== 0 || measured !== expected)
      throw new ActionError(`The selected ${name} executable does not provide version ${expected}.`);
    tools[name] = measured;
  }
  const runtimeBins = [...Object.values(runtimes).map((item) => item.bin), ...androidVerified.bins];
  const receipt = {
    schema_version: 1,
    platform: process.platform,
    architecture: process.arch,
    versions,
    tools,
    ...(android.entries.length ? { android: androidVerified.versions } : {}),
  };
  return {
    node: runtimes.node ?? null,
    bun: runtimes.bun ?? null,
    runtimeBins,
    runtimeEnv,
    folders,
    receipt,
  };
}

export function verify(environment) {
  return verifiedSelection(environment).receipt;
}

function selectionPayload(environment) {
  const fields = [
    "SDK_RUNNER_ENVIRONMENT",
    "SDK_MANAGED",
    "SDK_ANDROID_SDK",
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
    const { selected, resolvedEnv, tools, android } = resolveSelectionEnvironment(environment);
    supported(selected, process.platform, process.arch, android.entries);
    const plan = cachePlan(resolvedEnv);
    const selection = JSON.stringify(selectionPayload(resolvedEnv));
    const versionOutputs = names
      .map((name) => `${name}-version=${selected[name] ?? ""}`)
      .join("\n");
    if (environment.GITHUB_OUTPUT)
      appendFileSync(environment.GITHUB_OUTPUT,
        `bootstrap=${!managedRunner(environment.SDK_RUNNER_ENVIRONMENT, environment.SDK_MANAGED)}\ncache-key=${plan.key}\nselection=${selection}\n${versionOutputs}\nandroid-sdk=${android.normalized}\ntools=${tools}\ncache-paths<<NDDEV_SDK_PATHS\n${plan.paths.join("\n")}\nNDDEV_SDK_PATHS\n`);
    return;
  }
  if (mode !== "verify") throw new ActionError("Unknown hosted SDK command.");
  environment = mergeSelection(environment);
  const { resolvedEnv } = resolveSelectionEnvironment(environment);
  environment = resolvedEnv;
  const python = managedPython(environment);
  const { runtimeBins, runtimeEnv, folders, receipt } = verifiedSelection(python ? prependPath(environment, python.bin) : environment);
  const variables = {BUN_DO_NOT_TRACK: "1", DO_NOT_TRACK: "1", ...runtimeEnv};
  if (python) variables.UV_PYTHON = python.executable;
  // GitHub prepends each entry. Keep the verified directories ahead of the default SDK bin.
  const paths = [python?.bin, ...runtimeBins, ...folders].filter(Boolean);
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
