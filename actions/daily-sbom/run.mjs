import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scannerPolicy } from "../../lib/security-policy.mjs";

export function main(environment = process.env) {
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
  try {
    const run = (tool, args, report) => {
      console.log(`Running ${tool} for ${path.basename(report)}`);
      const result = spawnSync(
        path.join(tools, tool),
        ["--config", policy.config, ...args],
        {
          cwd: source,
          env: environment,
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
