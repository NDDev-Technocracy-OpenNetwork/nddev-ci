import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

export const runnerFailureReasons = new Set([
  "docker-timeout", "docker-unavailable", "cache-unavailable",
  "network-unavailable", "runner-storage",
  "disk-quota-exceeded", "bun-cache-eacces", "cargo-advisory-ownership",
]);

export const upstreamFailureReasons = new Set([
  "github-5xx", "github-transport", "ghcr-5xx", "ghcr-transport", "upstream-unavailable",
]);

export const failureReasonPattern = /^[a-z0-9-]{1,64}$/;

const timeout = /\b(?:timed out|timeout|deadline exceeded|did not finish within)\b/i;
const unavailable = /\b(?:connection (?:refused|reset)|failed to connect|cannot connect|no such host|network is unreachable|no route to host|unexpected EOF)\b/i;
const storage = /\b(?:no space left on device|read-only file system|input\/output error|ENOSPC|EROFS|EIO)\b/i;
const quota = /\b(?:disk quota exceeded|EDQUOT)\b/i;
const permission = /\b(?:permission denied|EACCES)\b/i;
const bunCacheRename = /\b(?:moving\s+"[^"]+"\s+to cache dir failed|renaming changes to cache dir)\b.*Permission denied \(rename\(\)\)/i;
const dubiousOwnership = /\bdetected dubious ownership in repository at\b/i;
const dockerCommand = /\bdocker["']?\s+(?:["']?(?:--host|-H)["']?\s+\S+\s+)?["']?(?:buildx|build|pull|compose)\b/i;
const dockerRegistryRead = /\bfailed to copy: httpReadSeeker:.*\/v2\/[^\s"]+\/manifests\//i;
const cacheService = /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?: code)?[ :]+|returned error: )(?:502|503|504)\b/i;
const sccacheDaemon = /\bsccache:\s*error:\s*(?:Server startup failed\b|(?:couldn't|failed to) connect to (?:sccache )?server\b|Connection to server timed out\b)/i;
const localOrTestLine = /\b(?:localhost|127\.0\.0\.1|\[::1\]|\.example\.test|\.invalid|assert(?:ion)?\s+failed|test\s+\S+\s+\.\.\.\s+FAILED)\b/i;
const http5xx = /\b(?:(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?: code)?[ :]+|returned(?: error)?:?\s+)(?:500|502|503|504)\b|(?:500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b)/i;
const transportFailure = /\b(?:timed out|timeout|deadline exceeded|connection (?:refused|reset)|broken pipe|unexpected EOF|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))\b/i;
const githubHost = /\b(?:(?:api|uploads)\.)?github\.com\b/i;
const githubClient5xx = /\bGitHub\b[^.\n]{0,60}\b(?:returned\s+)?HTTP(?:\/\d(?:\.\d)?)?\s*(?:500|502|503|504)\b/i;
const githubClientTransport = /\bGitHub\b[^.\n]{0,60}\b(?:transport (?:failed|error|did not complete)|timed out|connection reset|unexpected EOF)\b/i;
const ghcrHost = /\bghcr\.io\b/i;

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
  const bunCache = environment.BUN_INSTALL_CACHE_DIR;
  const cargoHome = environment.CARGO_HOME || "/opt/contour/cargo";
  const sccacheConfigured = Boolean(environment.SCCACHE_DIR || environment.SCCACHE_SERVER_UDS);
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
          (storage.test(line) || permission.test(line))) ||
        (sccacheConfigured && sccacheDaemon.test(line)))
      return "cache-unavailable";

    if ((registryError || mentions(line, proxy)) && (unavailable.test(line) || timeout.test(line)))
      return "network-unavailable";

    if (bunCache && permission.test(line) && (mentions(line, bunCache) || bunCacheRename.test(line)))
      return "bun-cache-eacces";

    if (dubiousOwnership.test(line) && mentions(line, cargoHome))
      return "cargo-advisory-ownership";

    if (quota.test(line))
      return "disk-quota-exceeded";

    if (storage.test(line) && storageRoots.some((directory) => mentions(line, directory)))
      return "runner-storage";
    return "";
  };
}

export function upstreamFailureClassifier() {
  return (line) => {
    if (!line || localOrTestLine.test(line)) return "";
    if (ghcrHost.test(line)) {
      if (http5xx.test(line)) return "ghcr-5xx";
      if (transportFailure.test(line)) return "ghcr-transport";
      return "";
    }
    if (githubHost.test(line)) {
      if (http5xx.test(line)) return "github-5xx";
      if (transportFailure.test(line)) return "github-transport";
      return "";
    }
    if (githubClient5xx.test(line)) return "github-5xx";
    if (githubClientTransport.test(line)) return "github-transport";
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
  const selfHosted = environment.RUNNER_ENVIRONMENT === "self-hosted";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env: environment, stdio: ["ignore", "pipe", "pipe"],
    });
    let runnerReason = "";
    let upstreamReason = "";
    const classifyRunner = selfHosted ? runnerFailureClassifier(environment) : null;
    const classifyUpstream = upstreamFailureClassifier();
    const inspect = (line) => {
      const text = line.replace(/\x1b\[[\d;]*m/g, "");
      if (classifyRunner) runnerReason = classifyRunner(text) || runnerReason;
      upstreamReason = classifyUpstream(text) || upstreamReason;
    };
    watch(child.stdout, process.stdout, inspect);
    watch(child.stderr, process.stderr, inspect);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      try {
        if (code !== 0 && output) {
          if (runnerReason) appendFileSync(output, `runner-reason=${runnerReason}\n`);
          else if (upstreamReason) appendFileSync(output, `upstream-reason=${upstreamReason}\n`);
        }
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
