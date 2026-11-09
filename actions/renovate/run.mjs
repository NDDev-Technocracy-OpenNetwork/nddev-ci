import { spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const input = (environment, name) => environment[`INPUT_${name.toUpperCase()}`] || "";
const refuse = (message) => { throw new Error(message); };

export function selections(environment) {
  if (environment.RUNNER_ENVIRONMENT !== "self-hosted") refuse("Renovate requires an explicitly selected managed runner.");
  const version = input(environment, "version");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) refuse("Renovate requires an exact stable version.");
  const owner = environment.GITHUB_REPOSITORY_OWNER?.toLowerCase();
  const repositories = input(environment, "repositories").split(/\s+/).filter(Boolean);
  if (!owner || !repositories.length || new Set(repositories.map((s) => s.toLowerCase())).size !== repositories.length ||
      repositories.some((name) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) || name.split("/")[0].toLowerCase() !== owner))
    refuse("Renovate repositories must be explicit, unique and belong to the caller's organization.");
  const timeout = Number(input(environment, "timeout-minutes") || "45");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout >= 60) refuse("Renovate timeout must fit within the App token's one-hour lifetime.");
  return {version, repositories, timeout};
}

export function directory(environment, value, optional = false) {
  const root = realpathSync(environment.RUNNER_TEMP);
  const requested = path.resolve(value || ".");
  const target = path.join(realpathSync(path.dirname(requested)), path.basename(requested));
  if (path.dirname(target) !== root || !/^nddev-renovate-[A-Za-z0-9]+$/.test(path.basename(target)))
    refuse("Renovate workspace must be its owned temporary directory.");
  let stat;
  try { stat = lstatSync(target); } catch (error) { if (optional && error.code === "ENOENT") return target; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("Renovate workspace must be its owned temporary directory.");
  return target;
}

export function configuration(environment, selected, workspace) {
  const username = input(environment, "dockerhub-username"), password = input(environment, "dockerhub-token");
  if (Boolean(username) !== Boolean(password) || /[\s\0]/.test(username)) refuse("Docker Hub read credentials require both username and token.");
  return {
    platform: "github", endpoint: environment.GITHUB_API_URL, repositories: selected.repositories,
    autodiscover: false, onboarding: false, requireConfig: "required", binarySource: "global",
    allowScripts: false, allowPlugins: false, allowedCommands: [], allowedEnv: [], exposeAllEnv: false,
    force: {automerge: false}, baseDir: workspace, cacheDir: path.join(workspace, "cache"),
    executionTimeout: selected.timeout, exitCodeForErrors: true,
    ...(username ? {hostRules: [{hostType: "docker", matchHost: "docker.io", username, password}]} : {}),
  };
}

export function childEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith("INPUT_") &&
    !name.startsWith("RENOVATE_") && !name.startsWith("GIT_CONFIG_") &&
    !["GH_TOKEN", "GITHUB_TOKEN", "NODE_OPTIONS", "GIT_SSH_COMMAND", "SSH_AUTH_SOCK"].includes(name)));
}

export function main(environment = process.env) {
  const mode = input(environment, "mode");
  if (mode === "cleanup") {
    rmSync(directory(environment, input(environment, "directory"), true), {recursive: true, force: true});
    return;
  }
  const selected = selections(environment);
  const clean = {...childEnvironment(environment), DO_NOT_TRACK: "1", LOG_FORMAT: "json", LOG_LEVEL: "info"};
  const measured = spawnSync("renovate", ["--version"], {env: clean, encoding: "utf8", timeout: 30000, maxBuffer: 65536});
  if (measured.error || measured.status !== 0 || measured.stdout.trim() !== selected.version)
    refuse("The managed Renovate executable does not match its exact selection.");
  if (mode === "prepare") {
    const workspace = mkdtempSync(path.join(realpathSync(environment.RUNNER_TEMP), "nddev-renovate-"));
    appendFileSync(environment.GITHUB_OUTPUT, `directory=${workspace}\nrepository-names<<NDDEV_RENOVATE_REPOSITORIES\n${selected.repositories.map((name) => name.split("/")[1]).join("\n")}\nNDDEV_RENOVATE_REPOSITORIES\n`);
    return workspace;
  }
  if (mode !== "run") refuse("Unknown Renovate action mode.");
  const workspace = directory(environment, input(environment, "directory"));
  const token = input(environment, "github-token");
  if (!token) refuse("A scoped installation token is required.");
  const config = configuration(environment, selected, workspace);
  const configFile = path.join(workspace, "global.json");
  writeFileSync(configFile, "{}\n", {mode: 0o600});
  const gitConfig = path.join(workspace, "gitconfig");
  writeFileSync(gitConfig, "", {mode: 0o600});
  const result = spawnSync("renovate", [], {cwd: workspace, stdio: "inherit", timeout: selected.timeout * 60000,
    env: {...clean, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitConfig,
      RENOVATE_CONFIG_FILE: configFile, RENOVATE_CONFIG: JSON.stringify(config), RENOVATE_TOKEN: token}});
  if (result.error || result.signal || result.status !== 0) refuse("Renovate did not complete successfully; its workspace will be cleaned.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try { main(); }
  catch (error) { console.error(`::error::${error.message.replace(/[\r\n%]/g, " ")}`); process.exitCode = 1; }
