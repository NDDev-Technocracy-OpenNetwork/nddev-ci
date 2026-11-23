import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

export const runnerFailureReasons = new Set([
  "docker-timeout", "docker-unavailable", "cache-unavailable",
  "network-unavailable", "runner-storage",
]);

const timeout = /\b(?:timed out|timeout|deadline exceeded|did not finish within)\b/i;
const unavailable = /\b(?:connection (?:refused|reset)|failed to connect|cannot connect|no such host|network is unreachable|no route to host|unexpected EOF)\b/i;
const storage = /\b(?:no space left on device|read-only file system|input\/output error|ENOSPC|EROFS|EIO)\b/i;
const permission = /\b(?:permission denied|EACCES)\b/i;
const dockerCommand = /\bdocker["']?\s+(?:["']?(?:--host|-H)["']?\s+\S+\s+)?["']?(?:buildx|build|pull|compose)\b/i;
const dockerRegistryRead = /\bfailed to copy: httpReadSeeker:.*\/v2\/[^\s"]+\/manifests\//i;
const cacheService = /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?: code)?[ :]+|returned error: )(?:502|503|504)\b/i;

function host(value) {
  try { return new URL(value).host; } catch { return ""; }
}

function mentions(text, address) {
  if (!address) return false;
  for (let position = text.indexOf(address); position >= 0; position = text.indexOf(address, position + 1)) {
    const end = position + address.length;
    if (!/[\w.:-]/.test(text[position - 1] ?? "") && !/[\w.-]/.test(text[end] ?? "") &&
        (text[end] !== ":" || !/\S/.test(text[end + 1] ?? ""))) return true;
  }
  return false;
}

export function runnerFailureClassifier(environment) {
  const docker = environment.NDDEV_DOCKER_HOST || environment.DOCKER_HOST;
  const socket = docker?.replace(/^unix:\/\//, "");
  const registry = host(environment.NDDEV_CI_ARTIFACT_REGISTRY);
  const proxy = host(environment.HTTPS_PROXY || environment.https_proxy);
  const storageRoots = [environment.RUNNER_TEMP, environment.RUNNER_TOOL_CACHE].filter(Boolean);
  return (line) => {
    if (docker && dockerRegistryRead.test(line) && timeout.test(line)) return "docker-timeout";
    if (docker && /"event"\s*:\s*"docker(?:[._][\w-]+)*\.request"/i.test(line) &&
        /"route"\s*:\s*"ping"/i.test(line) && /"status"\s*:\s*502\b/.test(line))
      return "docker-unavailable";
    if (mentions(line, docker) || mentions(line, socket)) {
      if (dockerCommand.test(line) && timeout.test(line)) return "docker-timeout";
      if (/(?:\/_ping\b|docker daemon).*\b502\b/i.test(line)) return "docker-unavailable";
      if (/docker daemon|\/v\d+\.\d+\//i.test(line) &&
          (unavailable.test(line) || storage.test(line) || permission.test(line)))
        return "docker-unavailable";
    }
    const registryError = mentions(line, registry);
    if ((registryError && cacheService.test(line)) ||
        (/\bsccache\b/i.test(line) && mentions(line, environment.SCCACHE_DIR) &&
          (storage.test(line) || permission.test(line))))
      return "cache-unavailable";

    if ((registryError || mentions(line, proxy)) && (unavailable.test(line) || timeout.test(line)))
      return "network-unavailable";

    if (storage.test(line) && storageRoots.some((directory) => mentions(line, directory)))
      return "runner-storage";
    return "";
  };
}

function watch(stream, destination, inspect) {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  const limit = 8192;
  stream.pipe(destination, {end: false});
  stream.on("data", (chunk) => {
    const lines = (partial + decoder.write(chunk)).split("\n");
    partial = lines.pop().slice(-limit);
    for (const line of lines) inspect(line.slice(-limit));
  });
  stream.on("end", () => {
    if (partial) inspect(partial + decoder.end());
  });
}

export function runProjectCommand(command, args, {cwd, environment = process.env, output = environment.GITHUB_OUTPUT} = {}) {
  const observe = environment.RUNNER_ENVIRONMENT === "self-hosted";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env: environment, stdio: observe ? ["inherit", "pipe", "pipe"] : "inherit",
    });
    let reason = "";
    if (observe) {
      const classify = runnerFailureClassifier(environment);
      const inspect = (line) => {
        const text = line.replace(/\x1b\[[\d;]*m/g, "");
        reason = classify(text) || reason;
      };
      watch(child.stdout, process.stdout, inspect);
      watch(child.stderr, process.stderr, inspect);
    }
    child.on("error", reject);
    child.on("close", (code, signal) => {
      try {
        if (code !== 0 && reason && output) appendFileSync(output, `runner-reason=${reason}\n`);
        resolve(code ?? (signal ? 128 + constants.signals[signal] : 1));
      } catch (error) {
        reject(error);
      }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  runProjectCommand(command, args).then((code) => { process.exitCode = code; }).catch(() => {
    console.error("::error::The project command could not complete.");
    process.exitCode = 1;
  });
}
