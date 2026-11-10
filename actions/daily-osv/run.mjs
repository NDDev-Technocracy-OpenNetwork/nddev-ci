import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetchDatabases, registry } from "../../lib/dependency-scan.mjs";
import { scannerPolicy } from "../../lib/security-policy.mjs";

export function main(
  environment = process.env,
  day = new Date().toISOString().slice(0, 10),
) {
  const source = environment.GITHUB_WORKSPACE;
  const binary = environment.INPUT_SCANNER;
  const output = environment.INPUT_OUTPUT;
  if (
    ![source, binary, output].every((value) => value && path.isAbsolute(value))
  )
    throw new Error(
      "Daily scans need absolute workspace, scanner and output paths.",
    );
  if (!environment.INPUT_LICENSES)
    throw new Error("Daily scans require their licence policy.");
  const policy = scannerPolicy(environment, "osv-scanner.toml");
  const declared = registry(environment);
  let database;
  try {
    const common = [
      "scan",
      "source",
      "-r",
      "--allow-no-lockfiles",
      "--format=json",
      "--verbosity=error",
      "--no-call-analysis",
      "--no-resolve",
      "--no-ignore",
      "--config",
      policy.config,
    ];
    const run = (flags) =>
      spawnSync(binary, [...common, ...flags, source], {
        cwd: source,
        env: database
          ? { ...environment, OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: database }
          : environment,
        encoding: "utf8",
        timeout: 600000,
        maxBuffer: 64 * 1024 * 1024,
      });
    const scan = (flags, name) => {
      const result = run(flags);
      if (result.stderr) process.stderr.write(result.stderr);
      if (
        result.error ||
        ![0, 1].includes(result.status) ||
        result.stderr.trim()
      )
        throw new Error(
          `OSV ${name} scan could not complete (status ${result.status}).`,
        );
      const report = JSON.parse(result.stdout);
      if (!Array.isArray(report.results))
        throw new Error(`OSV ${name} scan returned an invalid report.`);
      return result.stdout;
    };
    let lookup = [
      "--offline-vulnerabilities",
      "--download-offline-databases",
      "--data-source=native",
    ];
    if (declared) {
      // On a runner with a declared registry the databases come from it and not from the
      // scanner's own download. Without a database the scanner fails this first run and still
      // names every package's ecosystem, which tells the files to fetch.
      database = mkdtempSync(
        path.join(environment.RUNNER_TEMP || tmpdir(), "nddev-ci-osv-"),
      );
      const local = ["--offline", "--data-source=native", "--local-db-path", database];
      const listed = run(["--all-packages", ...local]);
      let report;
      try {
        if (listed.error) throw listed.error;
        report = JSON.parse(listed.stdout);
      } catch {
        throw new Error("OSV could not list the packages to look up.");
      }
      fetchDatabases(report, database, declared, environment, day);
      lookup = local;
    }
    const vulnerabilities = scan(lookup, "vulnerability");
    const licenses = scan(
      [`--licenses=${environment.INPUT_LICENSES}`],
      "licence",
    );
    mkdirSync(output, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(output, "osv.json"), vulnerabilities, {
      mode: 0o600,
    });
    writeFileSync(path.join(output, "licenses.json"), licenses, {
      mode: 0o600,
    });
  } finally {
    if (database) rmSync(database, { recursive: true, force: true });
    policy.cleanup();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `::error::${String(error.message).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`,
    );
    process.exitCode = 1;
  }
}
