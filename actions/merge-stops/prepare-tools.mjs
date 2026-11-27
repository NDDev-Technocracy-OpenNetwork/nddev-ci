// Prepares merge-stop tools for actions/merge-stops without hardcoded managed versions.
// Managed runners resolve verified binaries from NDDEV_CI_REGISTRY_SNAPSHOT and RUNNER_TOOL_CACHE.
// Hosted runners take explicit caller tool-pins, registry snapshot digests, or isolated compatibility pins.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { hostedMergeStopPins } from "../../lib/hosted-compat-pins.mjs";
import { loadRegistrySnapshot } from "../../lib/registry-resolve.mjs";
import { ActionError } from "../../lib/release-asset.mjs";
import { managedRunner } from "../../lib/runner-profile.mjs";
import {
  installHostedTool,
  linkManagedTool,
  parseCallerPins,
  runActionCli,
} from "../../lib/tool-prepare.mjs";

const toolSpecs = Object.freeze({
  betterleaks: {
    repository: "betterleaks/betterleaks",
    asset: (v, a) => `betterleaks_${v}_linux_${a === "x64" ? "x64" : "arm64"}.tar.gz`,
    member: () => "betterleaks",
  },
  poutine: {
    repository: "boostsecurityio/poutine",
    asset: (v, a) => `poutine_Linux_${a === "x64" ? "x86_64" : "arm64"}.tar.gz`,
    member: () => "poutine",
  },
  committed: {
    repository: "crate-ci/committed",
    asset: (v, a) => `committed-v${v}-${a === "x64" ? "x86_64" : "aarch64"}-unknown-linux-musl.tar.gz`,
    member: () => "./committed",
  },
  actionlint: {
    repository: "rhysd/actionlint",
    asset: (v, a) => `actionlint_${v}_linux_${a === "x64" ? "amd64" : "arm64"}.tar.gz`,
    member: () => "actionlint",
  },
  shellcheck: {
    repository: "koalaman/shellcheck",
    asset: (v, a) => `shellcheck-v${v}.linux.${a === "x64" ? "x86_64" : "aarch64"}.tar.gz`,
    member: (v) => `shellcheck-v${v}/shellcheck`,
  },
  jscpd: {
    repository: "kucherenko/jscpd",
    asset: (v, a) => `jscpd-linux-${a === "x64" ? "x64" : "arm64"}-musl.tar.gz`,
    member: () => "jscpd",
  },
  zizmor: {
    repository: "zizmorcore/zizmor",
    asset: (_v, a) => `zizmor-${a === "x64" ? "x86_64" : "aarch64"}-unknown-linux-gnu.tar.gz`,
    member: () => "zizmor",
  },
});

export function prepareMergeStopTools(environment = process.env) {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    throw new ActionError("The merge stops require a native Linux x64 or ARM64 runner.");
  }
  const tempRoot = (environment.RUNNER_TEMP ?? "").trim();
  if (!tempRoot || !path.isAbsolute(tempRoot)) {
    throw new ActionError("Preparing merge-stop tools requires RUNNER_TEMP.");
  }
  const newClones = environment.NEW_CLONES === "true" || environment["INPUT_NEW-CLONES"] === "true";
  const needed = [
    ...(newClones ? ["jscpd"] : []),
    "betterleaks",
    "poutine",
    "committed",
    "actionlint",
    "shellcheck",
    "zizmor",
  ];
  const binDir = path.join(tempRoot, "nddev-ci", "bin");
  mkdirSync(binDir, { recursive: true });

  const snapshot = loadRegistrySnapshot(environment);
  const isManaged = managedRunner(environment.RUNNER_ENVIRONMENT, environment.INPUT_MANAGED);
  const prepared = {};

  if (isManaged) {
    for (const toolName of needed) {
      prepared[toolName] = linkManagedTool(toolName, binDir, { environment, snapshot }).version;
    }
    return { binDir, versions: prepared };
  }

  const callerPins = parseCallerPins(environment.TOOL_PINS ?? environment["INPUT_TOOL-PINS"]);
  const loadFallbackPins = () => hostedMergeStopPins(environment);
  const stagingDir = mkdtempSync(path.join(tempRoot, "nddev-merge-tools-"));
  try {
    for (const toolName of needed) {
      const spec = toolSpecs[toolName];
      const chosen = installHostedTool({
        toolName,
        defaultRepository: spec.repository,
        defaultAsset: spec.asset,
        tarMember: spec.member,
        callerPins,
        loadFallbackPins,
        snapshot,
        arch: process.arch,
        binDir,
        stagingDir,
        environment,
      });
      prepared[toolName] = chosen.version;
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  return { binDir, versions: prepared };
}

runActionCli(import.meta.url, () => prepareMergeStopTools());
