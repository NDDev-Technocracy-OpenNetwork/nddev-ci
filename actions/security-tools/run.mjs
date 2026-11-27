// Prepares daily security scan tools for security.yml without hardcoded managed versions.
// Managed runners resolve verified binaries from NDDEV_CI_REGISTRY_SNAPSHOT and RUNNER_TOOL_CACHE.
// Hosted runners take explicit caller tool-pins or fall back to isolated hosted compatibility pins.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { hostedSecurityToolPins } from "../../lib/hosted-compat-pins.mjs";
import { loadRegistrySnapshot, resolveTool } from "../../lib/registry-resolve.mjs";
import { ActionError } from "../../lib/release-asset.mjs";
import { managedRunner } from "../../lib/runner-profile.mjs";
import {
  downloadGitHubReleaseAsset,
  installTarOrBinary,
  linkManagedTool,
  parseCallerPins,
  resolvePinDigest,
  runActionCli,
} from "../../lib/tool-prepare.mjs";

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

function downloadHostedScanner(spec, pin, arch, binDir, stagingDir, environment) {
  const { version, expectedSha } = resolvePinDigest(spec.name, pin, arch);
  const archive = path.join(stagingDir, `${spec.name}.download`);
  const token = spec.access === "token"
    ? (environment["INPUT_GITHUB-TOKEN"] ?? environment.GH_TOKEN ?? "").trim()
    : "";
  downloadGitHubReleaseAsset({
    toolName: spec.name,
    repository: spec.repository,
    tag: `v${version}`,
    assetName: spec.asset(version, arch),
    expectedSha,
    archivePath: archive,
    token,
    environment,
  });
  installTarOrBinary({
    toolName: spec.name,
    archivePath: archive,
    tarMember: spec.tarMember,
    stagingDir,
    targetPath: path.join(binDir, spec.name),
    environment,
  });
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
      const found = linkManagedTool(spec.name, binDir, { environment, snapshot });
      versions[spec.name] = found.version;
      envExports.push(`${spec.envVar}=${found.version}`);
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

runActionCli(import.meta.url, () => prepareSecurityTools());
