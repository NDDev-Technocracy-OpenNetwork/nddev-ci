import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

class ActionError extends Error {}
const configuration = JSON.parse(
  readFileSync(new URL("./just.json", import.meta.url), "utf8"),
);
const digest = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

export function parseArguments(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 65536)
    throw new ActionError(
      "Recipe arguments must be a bounded JSON array of strings.",
    );
  let args;
  try {
    args = JSON.parse(value);
  } catch {
    throw new ActionError("Recipe arguments are invalid JSON.");
  }
  if (
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )
    throw new ActionError(
      "Recipe arguments must be a JSON array of strings without NUL bytes.",
    );
  return args;
}

export function invocation({
  workspace,
  directory = ".",
  justfile = "justfile",
  recipe,
  arguments: raw = "[]",
}) {
  if (typeof recipe !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(recipe))
    throw new ActionError("A declared recipe name is required.");
  const root = realpathSync(workspace);
  const cwd = realpathSync(path.resolve(root, directory));
  const file = realpathSync(path.resolve(cwd, justfile));
  for (const candidate of [cwd, file]) {
    const relative = path.relative(root, candidate);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new ActionError(
        "Recipe paths must remain inside the checked-out workspace.",
      );
  }
  return {
    cwd,
    argv: ["--justfile", file, "--", recipe, ...parseArguments(raw)],
  };
}

async function download(asset, destination) {
  const url = `https://api.github.com/repos/casey/just/releases/assets/${asset.asset}`;
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "nddev-ci",
        },
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      if (attempt === 3)
        throw new ActionError("Pinned task runner transport did not complete.");
    }
    if (response?.ok) break;
    const transient =
      response === undefined ||
      [408, 429, 500, 502, 503, 504].includes(response.status);
    if (!transient || attempt === 3)
      throw new ActionError(
        `Pinned task runner download failed: HTTP ${response?.status ?? "unavailable"}.`,
      );
    const requested = Number(response?.headers.get("retry-after") ?? 0);
    if (Number.isFinite(requested) && requested > 30)
      throw new ActionError(
        "Pinned task runner source requested a later retry.",
      );
    if (response?.body) await response.body.cancel();
    console.log(
      `Transient asset transport ${response?.status ?? "unavailable"}; retrying the same pinned source (${attempt + 1}/3).`,
    );
    await delay(
      Math.max(2 ** attempt, Number.isFinite(requested) ? requested : 0) * 1000,
    );
    response = undefined;
  }
  if (!response.body)
    throw new ActionError("Pinned task runner response has no body.");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > asset.size)
      throw new ActionError(
        "Pinned task runner response exceeds its published size.",
      );
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks);
  if (size !== asset.size)
    throw new ActionError("Pinned task runner response is incomplete.");
  if (createHash("sha256").update(content).digest("hex") !== asset.sha256)
    throw new ActionError("Pinned task runner archive digest differs.");
  writeFileSync(destination, content);
}

async function executable(environment) {
  if (environment.RUNNER_ENVIRONMENT === "self-hosted") {
    const result = spawnSync("just", ["--version"], { encoding: "utf8" });
    if (
      result.status !== 0 ||
      result.stdout.trim() !== `just ${configuration.version}`
    )
      throw new ActionError(
        "The prepared runner must provide the pinned managed just frontend.",
      );
    return "just";
  }
  const target = `${process.platform}-${process.arch}`;
  const asset = configuration.targets[target];
  if (!asset)
    throw new ActionError(
      "This runner architecture has no admitted task runner asset.",
    );
  if (!environment.RUNNER_TEMP)
    throw new ActionError("A runner-owned temporary directory is required.");
  const directory = path.join(
    environment.RUNNER_TEMP,
    "nddev-ci",
    "just",
    configuration.version,
    target,
  );
  const binary = path.join(
    directory,
    process.platform === "win32" ? "just.exe" : "just",
  );
  if (!existsSync(binary) || digest(binary) !== asset.binary_sha256) {
    mkdirSync(directory, { recursive: true });
    const temporary = mkdtempSync(path.join(directory, "download-"));
    try {
      const archive = path.join(temporary, asset.name);
      await download(asset, archive);
      const extracted = spawnSync(
        "tar",
        ["-xf", archive, "-C", temporary, path.basename(binary)],
        { stdio: "inherit" },
      );
      const source = path.join(temporary, path.basename(binary));
      if (
        extracted.status !== 0 ||
        !existsSync(source) ||
        digest(source) !== asset.binary_sha256
      )
        throw new ActionError(
          "Extracted task runner differs from the admitted executable.",
        );
      chmodSync(source, 0o755);
      if (existsSync(binary)) rmSync(binary);
      renameSync(source, binary);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  if (environment.GITHUB_PATH)
    appendFileSync(environment.GITHUB_PATH, `${directory}\n`);
  return binary;
}

export async function main(environment = process.env) {
  const request = invocation({
    workspace: environment.GITHUB_WORKSPACE,
    directory: environment["INPUT_WORKING-DIRECTORY"],
    justfile: environment.INPUT_JUSTFILE,
    recipe: environment.INPUT_RECIPE,
    arguments: environment.INPUT_ARGUMENTS,
  });
  const just = await executable(environment);
  const version = spawnSync(just, ["--version"], { encoding: "utf8" });
  if (
    version.status !== 0 ||
    version.stdout.trim() !== `just ${configuration.version}`
  )
    throw new ActionError("Task runner version differs from its pin.");
  if (environment.GITHUB_OUTPUT)
    appendFileSync(
      environment.GITHUB_OUTPUT,
      `just-version=${configuration.version}\n`,
    );
  const result = spawnSync(just, request.argv, {
    cwd: request.cwd,
    stdio: "inherit",
    env: environment,
  });
  if (result.error || result.signal || result.status === null)
    throw new ActionError("Recipe process did not complete.");
  if (result.status !== 0)
    throw new ActionError(`Recipe failed with exit code ${result.status}.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `::error::${error instanceof ActionError ? error.message : "Recipe action failed before completion."}`,
    );
    process.exitCode = 1;
  });
}
