// One-off native scanner qualification. Vulnerable lockfiles are inert data, never installed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { downloadAsset } from "../../lib/release-asset.mjs";

const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "osv-contract-31-"));
const binary = path.join(root, "osv-scanner");
const db = path.join(root, "database");
const config = path.join(root, "empty.toml");
const asset = {
  repository: "google/osv-scanner",
  asset: 632251666,
  size: 57725088,
  sha256: "160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b",
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const env = { ...process.env, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: db, DO_NOT_TRACK: "1" };
function command(args) {
  const result = spawnSync(binary, args, { env, encoding: "utf8", timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.replace(/https?:\/\/\S+/g, "<url>") };
}
function scan(folder, download = false, extra = []) {
  const args = ["scan", "source", "--format=json", "--all-packages", "--no-call-analysis", "--no-resolve", "--data-source=native", "--no-ignore", "--config", config, "--local-db-path", db];
  args.push(...(download ? ["--offline-vulnerabilities", "--download-offline-databases"] : ["--offline"]));
  args.push(...extra, "-r", folder);
  return command(args);
}
function lock(directory, name, version) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify({
    name: "scanner-contract-data", version: "1.0.0", lockfileVersion: 3,
    packages: { "": { name: "scanner-contract-data", version: "1.0.0", dependencies: { [name]: version } }, [`node_modules/${name}`]: { name, version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` } },
  }));
}
function databases() {
  const entries = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else { assert(stat.isFile()); entries.push({ path: path.relative(db, file), size: stat.size, sha256: sha(fs.readFileSync(file)) }); }
    }
  }
  visit(db);
  assert(entries.length > 0);
  return entries;
}
try {
  await downloadAsset(asset, binary, process.env.GH_TOKEN);
  fs.chmodSync(binary, 0o555);
  fs.writeFileSync(config, "");
  const version = command(["--version"]);
  assert.equal(version.status, 0);
  assert(version.stdout.includes("2.7.0"));
  const union = path.join(root, "union");
  const base = path.join(union, "base");
  const head = path.join(union, "head");
  lock(base, "is-number", "7.0.0");
  lock(head, "vm2", "3.9.10");
  const preparation = scan(union, true);
  assert([0, 1].includes(preparation.status), preparation.stderr.slice(-1600));
  const prepared = JSON.parse(preparation.stdout);
  console.log(JSON.stringify({ preparation_status: preparation.status, preparation_diagnostics: preparation.stderr.slice(-2400), extracted: prepared.results?.map((s) => ({ source: s.source, packages: s.packages.map((p) => p.package) })), database_entries: fs.readdirSync(db) }));
  const before = databases();
  const old = scan(base);
  const current = scan(head);
  assert([0, 1].includes(old.status), old.stderr.slice(-1200));
  assert.equal(current.status, 1, current.stderr.slice(-1200));
  const oldReport = JSON.parse(old.stdout);
  const report = JSON.parse(current.stdout);
  const packages = report.results.flatMap((source) => source.packages);
  const candidate = packages.find((p) => p.package.name === "vm2");
  assert(candidate && candidate.vulnerabilities.length > 0);
  assert(candidate.groups.some((g) => Number(g.max_severity) >= 9));
  assert(candidate.vulnerabilities.some((v) => v.affected?.some((a) => a.package.name === "vm2" && a.package.ecosystem === "npm" && a.ranges?.some((range) => range.events.some((event) => event.fixed)))));
  fs.writeFileSync(path.join(head, "osv-scanner.toml"), '[[PackageOverrides]]\nname="vm2"\necosystem="npm"\nignore=true\n');
  const suppressed = scan(head);
  assert.equal(suppressed.status, 1, suppressed.stderr.slice(-1200));
  assert(JSON.parse(suppressed.stdout).results.flatMap((s) => s.packages).some((p) => p.package.name === "vm2" && p.vulnerabilities?.length));
  assert.deepEqual(databases(), before);
  const invalid = path.join(root, "invalid");
  fs.mkdirSync(invalid);
  fs.writeFileSync(path.join(invalid, "package-lock.json"), "{broken");
  const malformed = scan(invalid);
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(empty, "Cargo.lock"), "version=4\n");
  const noPackages = scan(empty);
  const allowedEmpty = scan(empty, false, ["--allow-no-lockfiles", "--verbosity=error"]);
  const quietClean = scan(base, false, ["--verbosity=error"]);
  const mixed = path.join(root, "mixed");
  lock(mixed, "is-number", "7.0.0");
  fs.mkdirSync(path.join(mixed, "bad"));
  fs.writeFileSync(path.join(mixed, "bad", "package-lock.json"), "{broken");
  const mixedResult = scan(mixed, false, ["--verbosity=error"]);
  console.log(JSON.stringify({ allowed_empty: allowedEmpty, quiet_clean: quietClean, mixed_invalid: mixedResult }));
  console.log(JSON.stringify({
    research_only: true, scanner: { version: version.stdout.trim(), ...asset },
    base_packages: oldReport.results.flatMap((s) => s.packages).length,
    head_package: candidate.package,
    head_groups: candidate.groups.map((g) => ({ ids: g.ids, aliases: g.aliases, max_severity: g.max_severity })),
    fixed: candidate.vulnerabilities.filter((v) => v.affected?.some((a) => a.package.name === "vm2" && a.ranges?.some((r) => r.events.some((e) => e.fixed)))).map((v) => v.id),
    database: before, frozen_database_unchanged: true, caller_suppression_overridden: true,
    malformed: { status: malformed.status, stderr: malformed.stderr.slice(-1500), stdout: malformed.stdout.slice(-250) },
    empty: { status: noPackages.status, stderr: noPackages.stderr.slice(-1500), stdout: noPackages.stdout.slice(-250) },
  }));
} finally {
  fs.rmSync(root, { recursive: true });
  console.log(JSON.stringify({ cleanup: !fs.existsSync(root) }));
}
