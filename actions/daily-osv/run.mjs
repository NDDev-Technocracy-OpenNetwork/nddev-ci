import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scannerPolicy } from "../../lib/security-policy.mjs";

export function main(environment = process.env) {
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
    const scan = (flags, name) => {
      const result = spawnSync(binary, [...common, ...flags, source], {
        cwd: source,
        env: environment,
        encoding: "utf8",
        timeout: 600000,
        maxBuffer: 64 * 1024 * 1024,
      });
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
    const vulnerabilities = scan(
      [
        "--offline-vulnerabilities",
        "--download-offline-databases",
        "--data-source=native",
      ],
      "vulnerability",
    );
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
