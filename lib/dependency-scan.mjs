import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { downloadAsset } from "./release-asset.mjs";
import { DependencyError, findings, compareReports } from "./dependency-report.mjs";

export const scannerPin = Object.freeze({
  version: "2.7.0", repository: "google/osv-scanner", tag: "v2.7.0",
  name: "osv-scanner_linux_amd64", asset: 632251666, size: 57725088,
  sha256: "160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b",
});
const refuse = (message) => { throw new DependencyError(message); };
async function checksum(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

export async function prepareScanner(directory, environment = process.env) {
  if (process.platform !== "linux" || process.arch !== "x64") refuse("The dependency guard requires its native Linux x64 security runner.");
  const binary = path.join(directory, "osv-scanner");
  if (environment.NDS_CACHE_BASE) {
    const base = new URL(environment.NDS_CACHE_BASE);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) refuse("Invalid declared security tool registry.");
    const url = `${base.href.replace(/\/$/, "")}/github-releases/sha256/${scannerPin.sha256}/${scannerPin.repository}/releases/download/${scannerPin.tag}/${scannerPin.name}`;
    const response = spawnSync("curl", ["--fail", "--silent", "--show-error", "--location", "--max-time", "180", "--max-filesize", String(scannerPin.size), "--output", binary, url], { env: environment, timeout: 190000, maxBuffer: 1048576 });
    if (response.error || response.status !== 0) refuse("The declared security tool registry could not provide the pinned scanner.");
  } else await downloadAsset(scannerPin, binary, environment.GH_TOKEN);
  const metadata = lstatSync(binary);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== scannerPin.size || await checksum(binary) !== scannerPin.sha256) refuse("Security scanner bytes differ from their pin.");
  chmodSync(binary, 0o500);
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10000, maxBuffer: 65536, env: { ...environment, DO_NOT_TRACK: "1" } });
  if (version.error || version.status !== 0 || version.stdout.split(/\r?\n/)[0] !== `osv-scanner version: ${scannerPin.version}`) refuse("The native security scanner cannot execute at its pinned version.");
  return binary;
}

async function databases(directory) {
  const entries = [];
  let size = 0;
  async function visit(folder) {
    for (const name of readdirSync(folder).sort()) {
      const file = path.join(folder, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) await visit(file);
      else {
        if (!stat.isFile() || stat.nlink !== 1 || !name.endsWith(".zip") || (size += stat.size) > 4 * 1024 ** 3 || entries.length >= 64) refuse("Invalid or unbounded security database snapshot.");
        entries.push({ path: path.relative(directory, file), size: stat.size, sha256: await checksum(file) });
      }
    }
  }
  await visit(directory);
  return entries;
}

// All inputs are inert lockfile bytes. A single preparation downloads the union of the
// ecosystems; both comparisons then use --offline against those exact database bytes.
export async function scanSources(binary, directory, input, environment = process.env) {
  const db = path.join(directory, "database");
  const config = path.join(directory, "empty.toml");
  const union = path.join(directory, "inputs");
  mkdirSync(db, { mode: 0o700 });
  writeFileSync(config, "", { flag: "wx", mode: 0o400 });
  const common = ["scan", "source", "--format=json", "--all-packages", "--allow-no-lockfiles", "--verbosity=error", "--no-call-analysis", "--no-resolve", "--data-source=native", "--no-ignore", "--config", config, "--local-db-path", db];
  function scan(folder, download = false) {
    const response = spawnSync(binary, [...common, ...(download ? ["--offline-vulnerabilities", "--download-offline-databases"] : ["--offline"]), "-r", folder], {
      env: { ...environment, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: db, DO_NOT_TRACK: "1" }, encoding: "utf8", timeout: 300000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    if (response.error || ![0, 1].includes(response.status) || response.stderr.trim()) {
      console.log(JSON.stringify({ dependency_scan: download ? "database-preparation" : "offline-comparison", status: response.status, diagnostics: response.stderr?.slice(-2000).replace(/https?:\/\/\S+/g, "<url>") }));
      refuse("Dependency extraction or vulnerability data was unavailable; no clean comparison was produced.");
    }
    let report;
    try { report = JSON.parse(response.stdout); }
    catch { refuse("The security scanner returned malformed JSON."); }
    return report;
  }
  const all = [...input.base.map((e) => `base/${e.path}`), ...input.head.map((e) => `head/${e.path}`)];
  const prepared = findings(scan(union, true), union, all);
  const frozen = await databases(db);
  if (prepared.packages && !frozen.length) refuse("Vulnerability database preparation produced no database bytes.");
  const base = findings(scan(path.join(union, "base")), path.join(union, "base"), input.base.map((e) => e.path));
  const head = findings(scan(path.join(union, "head")), path.join(union, "head"), input.head.map((e) => e.path));
  if (base.packages + head.packages !== prepared.packages) refuse("Dependency extraction changed between preparation and the frozen comparison.");
  if (JSON.stringify(await databases(db)) !== JSON.stringify(frozen)) refuse("Vulnerability database bytes changed during the comparison.");
  return { ...compareReports(base, head, input.renames), databases: frozen, scanner: scannerPin };
}
