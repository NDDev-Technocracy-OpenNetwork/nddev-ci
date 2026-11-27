// Prepares daily security scan tools for security.yml without hardcoded managed versions.
// Managed runners resolve verified binaries from NDDEV_CI_REGISTRY_SNAPSHOT and RUNNER_TOOL_CACHE.
// Hosted runners take explicit caller tool-pins, registry snapshot digests, or isolated compatibility pins.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { hostedSecurityToolPins } from "../../lib/hosted-compat-pins.mjs";
import { loadRegistrySnapshot } from "../../lib/registry-resolve.mjs";
import { ActionError } from "../../lib/release-asset.mjs";
import { managedRunner } from "../../lib/runner-profile.mjs";
import {
  installHostedTool,
  linkManagedTool,
  parseCallerPins,
  runActionCli,
} from "../../lib/tool-prepare.mjs";

const scannerSpecs = Object.freeze([
  {
    name: "trufflehog",
    envVar: "TRUFFLEHOG_VERSION",
    repository: "trufflesecurity/trufflehog",
    asset: (v, a) => `trufflehog_${v}_linux_${a === "x64" ? "amd64" : "arm64"}.tar.gz`,
    tarMember: "trufflehog",
  },
  {
    name: "kingfisher",
    envVar: "KINGFISHER_VERSION",
    repository: "mongodb/kingfisher",
    asset: (_v, a) => `kingfisher-linux-${a === "x64" ? "x64" : "arm64"}.tgz`,
    tarMember: "kingfisher",
  },
  {
    name: "osv-scanner",
    envVar: "OSV_SCANNER_VERSION",
    repository: "google/osv-scanner",
    asset: (_v, a) => `osv-scanner_linux_${a === "x64" ? "amd64" : "arm64"}`,
    tarMember: "",
  },
  {
    name: "syft",
    envVar: "SYFT_VERSION",
    repository: "anchore/syft",
    asset: (v, a) => `syft_${v}_linux_${a === "x64" ? "amd64" : "arm64"}.tar.gz`,
    tarMember: "syft",
  },
  {
    name: "grype",
    envVar: "GRYPE_VERSION",
    repository: "anchore/grype",
    asset: (v, a) => `grype_${v}_linux_${a === "x64" ? "amd64" : "arm64"}.tar.gz`,
    tarMember: "grype",
  },
  {
    name: "trivy",
    envVar: "TRIVY_VERSION",
    repository: "aquasecurity/trivy",
    asset: (v, a) => `trivy_${v}_Linux-${a === "x64" ? "64bit" : "ARM64"}.tar.gz`,
    tarMember: "trivy",
  },
]);

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
    const loadFallbackPins = () => hostedSecurityToolPins(environment);
    const stagingDir = mkdtempSync(path.join(tempRoot, "nddev-security-tools-"));
    try {
      for (const spec of scannerSpecs) {
        const chosen = installHostedTool({
          toolName: spec.name,
          defaultRepository: spec.repository,
          defaultAsset: spec.asset,
          tarMember: spec.tarMember,
          callerPins,
          loadFallbackPins,
          snapshot,
          arch: process.arch,
          binDir,
          stagingDir,
          environment,
        });
        versions[spec.name] = chosen.version;
        envExports.push(`${spec.envVar}=${chosen.version}`);
      }
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
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
