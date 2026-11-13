import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registry } from "../../lib/dependency-scan.mjs";
import { scannerPolicy } from "../../lib/security-policy.mjs";

// Where Grype and Trivy take their vulnerability databases when the runner declares a registry:
// Grype's listing and archive as the registry's copy of the day, Trivy's databases through the
// registry's route to their container registry. Without a declared registry each scanner keeps
// its public source.
export function databases(environment, day) {
  const declared = registry(environment);
  if (!declared) return {};
  const images = `${new URL(declared).host}/ghcr.io/aquasecurity`;
  return {
    GRYPE_DB_UPDATE_URL: `${declared}/grype/${day}`,
    TRIVY_DB_REPOSITORY: `${images}/trivy-db:2`,
    TRIVY_JAVA_DB_REPOSITORY: `${images}/trivy-java-db:1`,
  };
}

// Grype's database, imported once per release of it into the runner's persistent build cache.
// The import turns the 200 MB archive into a 3.4 GB indexed database, which every daily job wrote
// again before. The folder is named by the archive's digest from the provider's listing; Grype
// checks the database against its own digest at every start, and a database that fails that is
// imported anew. Runners without a persistent cache keep the per-job download.
export function grypeCache(environment, day, tools) {
  const declared = registry(environment);
  const root = environment.NDDEV_BUILD_CACHE_ROOT;
  if (!declared || !root || !path.isAbsolute(root) || !existsSync(root)) return {};
  const fetch = (url, output) => {
    const result = spawnSync(
      "curl",
      ["--fail", "--silent", "--show-error", "--max-time", "600", "--max-filesize", String(1 << 30),
        ...(output ? ["--output", output] : []), url],
      { env: environment, encoding: output ? undefined : "utf8", timeout: 610000, maxBuffer: 1 << 20 },
    );
    if (result.error || result.status !== 0)
      throw new Error("The declared registry could not provide Grype's database.");
    return result.stdout;
  };
  const base = `${declared}/grype/${day}/v6`;
  let listing;
  try {
    listing = JSON.parse(fetch(`${base}/latest.json`));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Grype's database listing is not JSON.");
    throw error;
  }
  const digest = /^sha256:([0-9a-f]{64})$/.exec(listing?.checksum ?? "")?.[1];
  if (!digest || !/^[A-Za-z0-9._:-]{1,200}\.tar\.zst$/.test(listing?.path ?? ""))
    throw new Error("Grype's database listing names no archive and digest.");
  const cache = path.join(root, "nddev-ci", "grype");
  const database = path.join(cache, digest);
  const variables = {
    GRYPE_DB_CACHE_DIR: database,
    GRYPE_DB_AUTO_UPDATE: "false",
    GRYPE_DB_VALIDATE_BY_HASH_ON_START: "true",
    GRYPE_CHECK_FOR_APP_UPDATE: "false",
  };
  const grype = (args) =>
    spawnSync(path.join(tools, "grype"), args, {
      env: { ...environment, ...variables },
      encoding: "utf8",
      timeout: 600000,
      maxBuffer: 1 << 20,
    });
  const status = grype(["db", "status"]);
  if (status.status === 0 && /^Status:\s+valid$/m.test(status.stdout)) return variables;
  // Missing, partial, outdated or altered: import this release again from its checked archive.
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(cache)) rmSync(path.join(cache, name), { recursive: true, force: true });
  const download = mkdtempSync(path.join(environment.RUNNER_TEMP || cache, "nddev-ci-grype-"));
  try {
    const archive = path.join(download, "database.tar.zst");
    fetch(`${base}/${listing.path}`, archive);
    const sum = spawnSync("sha256sum", [archive], { encoding: "utf8" });
    if (sum.status !== 0 || sum.stdout.slice(0, 64) !== digest)
      throw new Error("Grype's database archive differs from its listing.");
    const partial = `${database}.partial`;
    const imported = spawnSync(path.join(tools, "grype"), ["db", "import", archive], {
      env: { ...environment, ...variables, GRYPE_DB_CACHE_DIR: partial },
      encoding: "utf8",
      timeout: 600000,
      maxBuffer: 1 << 20,
    });
    if (imported.error || imported.status !== 0)
      throw new Error("Grype could not import its database.");
    renameSync(partial, database);
  } finally {
    rmSync(download, { recursive: true, force: true });
  }
  const checked = grype(["db", "status"]);
  if (checked.status !== 0 || !/^Status:\s+valid$/m.test(checked.stdout))
    throw new Error("Grype's imported database is not valid.");
  return variables;
}

export function main(
  environment = process.env,
  day = new Date().toISOString().slice(0, 10),
) {
  const source = environment.GITHUB_WORKSPACE;
  const tools = environment.INPUT_TOOLS;
  const output = environment.INPUT_OUTPUT;
  if (
    ![source, tools, output].every((value) => value && path.isAbsolute(value))
  )
    throw new Error(
      "Daily package scans need absolute workspace, tools and output paths.",
    );
  let callerFiles = [];
  if (environment.INPUT_SBOMS) {
    if (
      !path.isAbsolute(environment.INPUT_SBOMS) ||
      !existsSync(environment.INPUT_SBOMS) ||
      !lstatSync(environment.INPUT_SBOMS).isDirectory()
    )
      throw new Error(
        "Caller SBOMs require their real absolute input directory.",
      );
    callerFiles = readdirSync(environment.INPUT_SBOMS).filter((name) =>
      name.endsWith(".json"),
    );
    if (!callerFiles.length)
      throw new Error("Caller SBOM directory contains no JSON inventories.");
  }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const policy = scannerPolicy(environment, "scanners.yaml");
  const scanners = {
    ...environment,
    ...databases(environment, day),
    ...grypeCache(environment, day, tools),
  };
  try {
    const run = (tool, args, report) => {
      console.log(`Running ${tool} for ${path.basename(report)}`);
      const result = spawnSync(
        path.join(tools, tool),
        ["--config", policy.config, ...args],
        {
          cwd: source,
          env: scanners,
          encoding: "utf8",
          timeout: 600000,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error || result.status !== 0)
        throw new Error(
          `${tool} could not complete ${path.basename(report)} (status ${result.status}).`,
        );
      if (tool === "grype") {
        JSON.parse(result.stdout);
        writeFileSync(report, result.stdout, { mode: 0o600 });
      }
    };
    const sboms = [];
    const inventory = (input, name) => {
      const file = path.join(output, `sbom-${name}.json`);
      run("syft", [input, "-o", `cyclonedx-json=${file}`], file);
      sboms.push(file);
      return file;
    };
    inventory(`dir:${source}`, "repository");
    let number = 0;
    for (const image of (environment.INPUT_IMAGES ?? "").split("\n")) {
      if (!image.trim()) continue;
      const file = inventory(image.trim(), `image-${++number}`);
      writeFileSync(file.slice(0, -5) + ".name", image.trim() + "\n", {
        mode: 0o600,
      });
    }
    if (environment.INPUT_SBOMS) {
      for (const name of callerFiles) {
        const from = path.join(environment.INPUT_SBOMS, name);
        if (!lstatSync(from).isFile())
          throw new Error("Caller SBOMs must be regular files.");
        const into = path.join(output, `sbom-caller-${name}`);
        copyFileSync(from, into);
        const label = from.slice(0, -5) + ".name";
        if (existsSync(label)) {
          if (!lstatSync(label).isFile())
            throw new Error("Caller SBOM labels must be regular files.");
          copyFileSync(label, into.slice(0, -5) + ".name");
        }
        sboms.push(into);
      }
    }
    for (const sbom of sboms) {
      const name = path.basename(sbom, ".json");
      const grype = path.join(output, `grype-${name}.json`);
      run("grype", [`sbom:${sbom}`, "-o", "json"], grype);
      const trivy = path.join(output, `trivy-${name}.json`);
      run(
        "trivy",
        [
          "sbom",
          "--ignorefile",
          policy.config,
          "--exit-code=0",
          "--format=json",
          "--output",
          trivy,
          sbom,
        ],
        trivy,
      );
    }
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
