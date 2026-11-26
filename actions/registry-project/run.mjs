import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registry } from "../artifact-registry/run.mjs";
import { fetch as fetchObjects } from "../../lib/change-objects.mjs";

const commit = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const maximumArchive = 32 * 1024 * 1024;
const maximumExecutable = 64 * 1024 * 1024;
const maximumReport = 16 * 1024 * 1024;

export function archiveSelector(snapshot) {
  const asset = snapshot?.registry_cli_asset;
  const ids = [asset?.repository_id, asset?.release_id, asset?.asset_id];
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0) ||
      typeof asset?.sha256 !== "string" || !digest.test(asset.sha256))
    throw new Error("The protected registry snapshot has no valid CLI archive selector.");
  const path = ["/github-releases/sha256", asset.sha256, "private", ...ids].join("/");
  return {sha256: asset.sha256, path};
}

export async function downloadArchive(gateway, asset) {
  if (!gateway) throw new Error("The managed runner did not provide an artifact gateway.");
  let response;
  try {
    response = await fetch(gateway + asset.path, {
      headers: {"Accept": "application/octet-stream", "Accept-Encoding": "identity"},
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error("The registry CLI archive could not be fetched from the runner gateway.");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("The runner gateway refused the registry CLI archive (HTTP " + response.status + ").");
  }
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    await response.body.cancel();
    throw new Error("The gateway must return the exact compressed registry archive bytes.");
  }
  const hash = createHash("sha256");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximumArchive) throw new Error("The registry CLI archive exceeds its size limit.");
    hash.update(chunk);
    chunks.push(chunk);
  }
  if (hash.digest("hex") !== asset.sha256)
    throw new Error("The registry CLI archive does not match the protected SHA-256.");
  return Buffer.concat(chunks, size);
}

function executable(bytes, directory) {
  const archive = join(directory, "registry.tar.gz");
  writeFileSync(archive, bytes, {flag: "wx", mode: 0o600});
  const members = spawnSync("tar", ["-tzf", archive], {
    encoding: "utf8", timeout: 15000, maxBuffer: 1024,
  });
  if (members.error || members.status !== 0 || members.stdout !== "registry\n")
    throw new Error("The registry CLI archive must contain exactly the registry executable.");
  // Read one member to stdout. Archive paths and modes never become filesystem metadata.
  const unpacked = spawnSync("tar", ["-xOzf", archive, "--", "registry"], {
    timeout: 15000, maxBuffer: maximumExecutable,
  });
  if (unpacked.error || unpacked.status !== 0 || !unpacked.stdout.length)
    throw new Error("The registry CLI executable could not be extracted.");
  const path = join(directory, "registry");
  writeFileSync(path, unpacked.stdout, {flag: "wx", mode: 0o700});
  return path;
}

function commandValue(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/%/g, "%25");
}

function printFinding(finding, level) {
  const choice = finding?.name ?? finding?.key;
  if (typeof choice !== "string" || choice.length === 0)
    throw new Error("The registry CLI returned a finding without a choice.");
  const details = [choice, finding.declared ?? finding.version, finding.path].filter(Boolean);
  console.log("::" + level + "::Registry choice: " + commandValue(details.join(" | ")));
}

export function reportResult(stdout, status, base, block) {
  if (status !== 0 && status !== 3)
    throw new Error("The registry project scan failed before producing a verdict.");
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error("The registry project scan did not produce a JSON verdict.");
  }
  if (report?.read_complete !== true ||
      !Array.isArray(report.missing) || !Array.isArray(report.outside_lines) ||
      (base && (!Array.isArray(report.new) || report.base !== base || (status === 3) !== Boolean(report.new.length))) ||
      (!base && status !== 0))
    throw new Error("The registry project scan produced an incomplete or inconsistent verdict.");
  if (status === 3)
    for (const finding of report.new) printFinding(finding, block ? "error" : "notice");
  console.log(JSON.stringify({
    checked: report.checked,
    missing: report.missing,
    outside_lines: report.outside_lines,
    new: report.new,
  }));
  return status === 3 && block ? 1 : 0;
}

export async function main(environment = process.env) {
  const {GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temp, NDDEV_CI_REGISTRY_SNAPSHOT: snapshot} = environment;
  if (environment.RUNNER_OS !== "Linux" || environment.RUNNER_ARCH !== "X64")
    throw new Error("The registry project check requires a managed Linux x64 runner.");
  if (![workspace, temp, snapshot].every((entry) => typeof entry === "string" && isAbsolute(entry)))
    throw new Error("The registry project check needs the checked-out source and protected snapshot.");
  const base = environment.INPUT_BASE ?? "";
  const selected = /^0{40}$/.test(base) ? "" : base;
  const block = environment.INPUT_BLOCK === "true";
  if ((selected && !commit.test(selected)) || (block && !selected))
    throw new Error("The registry project check needs the exact base commit of this change.");
  const checked = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace, encoding: "utf8", timeout: 5000,
  });
  if (checked.error || checked.status !== 0 || !commit.test(environment.GITHUB_SHA ?? "") ||
      checked.stdout.trim() !== environment.GITHUB_SHA)
    throw new Error("The registry project check did not receive the exact source commit.");
  const gateway = registry({NDDEV_CI_ARTIFACT_REGISTRY: environment.NDDEV_CI_ARTIFACT_REGISTRY});
  const asset = archiveSelector(JSON.parse(readFileSync(snapshot, "utf8")));
  const directory = mkdtempSync(join(temp, "nddev-ci-registry-"));
  try {
    const binary = executable(await downloadArchive(gateway, asset), directory);
    if (selected && selected !== environment.GITHUB_SHA)
      fetchObjects(workspace, [selected], {
        server: environment.GITHUB_SERVER_URL,
        token: environment["INPUT_GITHUB-TOKEN"],
        completeTree: true,
      });
    const scanEnvironment = {...environment, GIT_NO_REPLACE_OBJECTS: "1"};
    for (const name of ["INPUT_GITHUB-TOKEN", "GH_TOKEN", "GITHUB_TOKEN"])
      delete scanEnvironment[name];
    const result = spawnSync(
      binary, ["project", workspace, "--snapshot", snapshot, ...(selected ? ["--base", selected] : [])],
      {encoding: "utf8", timeout: 120000, maxBuffer: maximumReport, cwd: directory, env: scanEnvironment},
    );
    if (result.error) throw new Error("The registry project scan could not finish.");
    const exit = reportResult(result.stdout, result.status, selected, block);
    if (exit !== 0 && environment.GITHUB_OUTPUT) {
      appendFileSync(environment.GITHUB_OUTPUT, "failure-layer=project\nfailure-reason=registry-check-failed\n");
    }
    return exit;
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, "failure-reason=registry-scan-failed\n");
    }
    console.error("::error::" + commandValue(error.message));
    process.exitCode = 1;
  }
}
