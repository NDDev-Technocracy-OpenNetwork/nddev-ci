import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionError } from "../../lib/release-asset.mjs";

const names = ["node", "python", "uv", "bun", "rust"];
const key = (name) => `SDK_${name.toUpperCase()}_VERSION`;

export function selections(environment) {
  if (environment.SDK_RUNNER_ENVIRONMENT !== "github-hosted")
    throw new ActionError("Hosted SDK preparation requires a hosted runner.");
  const selected = {};
  for (const name of names) {
    const version = environment[key(name)] ?? "";
    if (version === "") continue;
    if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version))
      throw new ActionError(`The ${name} selection must be an exact stable version.`);
    selected[name] = version;
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

export function verify(environment) {
  const selected = selections(environment);
  const versions = {};
  for (const [name, expected] of Object.entries(selected)) {
    const command = name === "rust" ? "rustc" : name;
    const result = spawnSync(command, ["--version"], {
      env: environment, encoding: "utf8", timeout: 30000, maxBuffer: 65536,
      windowsHide: true,
    });
    const expression = name === "node" ? /^v([^\s]+)$/ :
      name === "bun" ? /^([^\s]+)$/ : new RegExp(`^${command === "rustc" ? "rustc" : name === "python" ? "Python" : name} ([^\\s]+)(?: |$)`);
    const actual = result.stdout?.trim().match(expression)?.[1];
    if (result.error || result.status !== 0 || actual !== expected)
      throw new ActionError(`The selected ${name} executable does not provide version ${expected}.`);
    versions[name] = actual;
  }
  return {schema_version: 1, platform: process.platform, architecture: process.arch, versions};
}

export function main(mode, environment = process.env) {
  if (mode === "validate") {
    selections(environment);
    return;
  }
  if (mode !== "verify") throw new ActionError("Unknown hosted SDK command.");
  const receipt = verify(environment);
  const variables = {BUN_DO_NOT_TRACK: "1", DO_NOT_TRACK: "1"};
  if (receipt.versions.uv) {
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
