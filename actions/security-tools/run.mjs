// Prepares daily security scan tools for security.yml without hardcoded managed versions.
// Managed runners resolve verified binaries from NDDEV_CI_REGISTRY_SNAPSHOT and RUNNER_TOOL_CACHE.
// Hosted runners take explicit caller tool-pins or fall back to isolated hosted compatibility pins.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostedSecurityToolPins } from "../../lib/hosted-compat-pins.mjs";
import {
  findManagedTool,
  loadRegistrySnapshot,
  resolveTool,
} from "../../lib/registry-resolve.mjs";
import { ActionError } from "../../lib/release-asset.mjs";
import { managedRunner } from "../../lib/runner-profile.mjs";

const shaPattern = /^[0-9a-f]{64}$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

const scannerSpecs = Object.freeze([
  {
    name: "trufflehog",
    envVar: "TRUFFLEHOG_VERSION",
    repository: "trufflesecurity/trufflehog",
    asset: (v, a) => `trufflehog_${v}_linux_${a === "x64" ? "amd64" : "arm64"}.tar.gz`,
    tarMember: "trufflehog",
    access: "token",
  },
  {
    name: "kingfisher",
    envVar: "KINGFISHER_VERSION",
    repository: "mongodb/kingfisher",
    asset: (_v, a) => `kingfisher-linux-${a === "x64" ? "x64" : "arm64"}.tgz`,
    tarMember: "kingfisher",
    access: "token",
  },
  {
    name: "osv-scanner",
    envVar: "OSV_SCANNER_VERSION",
    repository: "google/osv-scanner",
    asset: (_v, a) => `osv-scanner_linux_${a === "x64" ? "amd64" : "arm64"}`,
    tarMember: "",
    access: "token",
  },
  {
    name: "syft",
    envVar: "SYFT_VERSION",
    repository: "anchore/syft",
    asset: (v, a) => `syft_${v}_linux_${a === "x64" ? "amd64" : "arm64"}.tar.gz`,
    tarMember: "syft",
    access: "token",
  },
  {
    name: "grype",
    envVar: "GRYPE_VERSION",
    repository: "anchore/grype",
    asset: (v, a) => `grype_${v}_linux_${a === "x64" ? "amd64" : "arm64"}.tar.gz`,
    tarMember: "grype",
    access: "token",
  },
  {
    name: "trivy",
    envVar: "TRIVY_VERSION",
    repository: "aquasecurity/trivy",
    asset: (v, a) => `trivy_${v}_Linux-${a === "x64" ? "64bit" : "ARM64"}.tar.gz`,
    tarMember: "trivy",
    // Trivy's upstream restricts organization-token access; always use public access.
    access: "public",
  },
]);

function parseCallerPins(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ActionError("tool-pins must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ActionError("tool-pins must be a JSON object.");
  }
  return parsed;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function curlToFile(url, output, headers, environment) {
  const args = ["--fail", "--silent", "--show-error", "--location", "--max-time", "180"];
  for (const header of headers) args.push("-H", header);
  args.push("--output", output, url);
  const res = spawnSync("curl", args, { env: environment, encoding: "utf8", timeout: 190000 });
  if (res.error || res.status !== 0) {
    throw new ActionError(`Could not download security tool archive from ${new URL(url).host}.`);
  }
}

function curlJson(url, headers, environment) {
  const args = ["--fail", "--silent", "--show-error", "--location", "--max-time", "60"];
  for (const header of headers) args.push("-H", header);
  args.push(url);
  const res = spawnSync("curl", args, {
    env: environment,
    encoding: "utf8",
    timeout: 70000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    throw new ActionError(`Could not fetch release metadata from ${new URL(url).host}.`);
  }
  return JSON.parse(res.stdout);
}

function downloadHostedScanner(spec, pin, arch, binDir, stagingDir, environment) {
  const version = pin.version;
  const expectedSha = typeof pin.sha256 === "string" ? pin.sha256 : pin.sha256?.[arch];
  if (!versionPattern.test(version ?? "") || !shaPattern.test(expectedSha ?? "")) {
    throw new ActionError(`Security scanner ${spec.name} requires an exact version and ${arch} SHA-256.`);
  }
  const assetName = spec.asset(version, arch);
  const tag = `v${version}`;
  const registry = (environment.NDDEV_CI_ARTIFACT_REGISTRY ?? "").replace(/\/+$/, "");
  const token = spec.access === "token" ? (environment["INPUT_GITHUB-TOKEN"] ?? environment.GH_TOKEN ?? "").trim() : "";
  const archive = path.join(stagingDir, `${spec.name}.download`);
  const target = path.join(binDir, spec.name);

  console.log(`Fetching check tool ${spec.repository}@${tag}: ${assetName}`);
  if (registry) {
    console.log("Using the configured artifact registry.");
    curlToFile(
      `${registry}/github-releases/sha256/${expectedSha}/${spec.repository}/releases/download/${tag}/${assetName}`,
      archive,
      [],
      environment,
    );
  } else {
    const headers = token ? [`Authorization: Bearer ${token}`] : [];
    const release = curlJson(
      `https://api.github.com/repos/${spec.repository}/releases/tags/${tag}`,
      [...headers, "Accept: application/vnd.github+json"],
      environment,
    );
    const matches = (release.assets ?? []).filter((entry) => entry.name === assetName);
    if (matches.length !== 1 || typeof matches[0].id !== "number") {
      throw new ActionError(`Release asset ${assetName} for ${spec.repository}@${tag} is missing or ambiguous.`);
    }
    curlToFile(
      `https://api.github.com/repos/${spec.repository}/releases/assets/${matches[0].id}`,
      archive,
      [...headers, "Accept: application/octet-stream"],
      environment,
    );
  }

  if (sha256File(archive) !== expectedSha) {
    throw new ActionError(`Downloaded ${spec.name} archive differs from its SHA-256.`);
  }
  if (!spec.tarMember) {
    copyFileSync(archive, target);
    chmodSync(target, 0o755);
    return;
  }
  const dest = path.join(stagingDir, spec.name);
  mkdirSync(dest, { recursive: true });
  const untar = spawnSync("tar", ["-xzf", archive, "-C", dest, spec.tarMember], {
    env: environment,
    encoding: "utf8",
    timeout: 60000,
  });
  if (untar.error || untar.status !== 0) {
    throw new ActionError(`Could not extract ${spec.name} from its archive.`);
  }
  copyFileSync(path.join(dest, spec.tarMember), target);
  chmodSync(target, 0o755);
}

export function prepareSecurityTools(environment = process.env) {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    throw new ActionError("The daily security scan requires a native Linux x64 or ARM64 runner.");
  }
  const tempRoot = (environment.RUNNER_TEMP ?? "").trim();
  if (!tempRoot || !path.isAbsolute(tempRoot)) {
    throw new ActionError("Preparing security tools requires RUNNER_TEMP.");
  }
  const binDir = path.join(tempRoot, "security", "bin");
  mkdirSync(binDir, { recursive: true });

  const snapshot = loadRegistrySnapshot(environment);
  const isManaged = managedRunner(environment.RUNNER_ENVIRONMENT, environment.INPUT_MANAGED);
  const envExports = [];
  const versions = {};

  if (isManaged) {
    for (const spec of scannerSpecs) {
      const found = findManagedTool(spec.name, { environment, snapshot });
      const linkPath = path.join(binDir, spec.name);
      rmSync(linkPath, { force: true });
      symlinkSync(found.binary, linkPath);
      versions[spec.name] = found.version;
      envExports.push(`${spec.envVar}=${found.version}`);
      console.log(`Using preinstalled ${spec.name}@${found.version} from tool cache.`);
    }
  } else {
    const callerPins = parseCallerPins(environment["INPUT_TOOL-PINS"] ?? environment.TOOL_PINS);
    const fallbackPins = hostedSecurityToolPins(environment);
    const staging = mkdtempSync(path.join(tempRoot, "nddev-security-tools-"));
    try {
      for (const spec of scannerSpecs) {
        const pin = callerPins[spec.name] ?? fallbackPins[spec.name];
        if (!pin) throw new ActionError(`No hosted pin configured for security tool ${spec.name}.`);
        if (snapshot) resolveTool(snapshot, spec.name, pin.version);
        const target = path.join(binDir, spec.name);
        if (existsSync(target)) rmSync(target, { force: true });
        downloadHostedScanner(spec, pin, process.arch, binDir, staging, environment);
        versions[spec.name] = pin.version;
        envExports.push(`${spec.envVar}=${pin.version}`);
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  if (environment.GITHUB_PATH) {
    appendFileSync(environment.GITHUB_PATH, `${binDir}\n`);
  }
  if (environment.GITHUB_ENV) {
    appendFileSync(environment.GITHUB_ENV, `${envExports.join("\n")}\n`);
  }
  return { binDir, versions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    prepareSecurityTools();
  } catch (error) {
    console.error(`::error::${error instanceof ActionError ? error.message : error.message}`);
    process.exitCode = 1;
  }
}
