import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_POLICY_PATH,
  inspectDirectory,
  inspectOciArchive,
  inspectTarArchive,
  loadPolicy,
} from "../../lib/artifact-traces.mjs";

function resolveTarget(value, workspace) {
  return path.isAbsolute(value) ? value : path.resolve(workspace, value);
}

export async function main(environment = process.env) {
  const workspace = environment.GITHUB_WORKSPACE || process.cwd();
  const directory = (environment.INPUT_DIRECTORY ?? "").trim();
  const tar = (environment.INPUT_TAR ?? "").trim();
  const ociArchive = (environment["INPUT_OCI-ARCHIVE"] ?? environment.INPUT_OCI_ARCHIVE ?? "").trim();
  const policyInput = (environment.INPUT_POLICY ?? "").trim();

  const selected = [
    directory && ["directory", directory],
    tar && ["tar", tar],
    ociArchive && ["oci-archive", ociArchive],
  ].filter(Boolean);

  if (selected.length !== 1) {
    throw new Error("Artifact trace inspection requires exactly one of directory, tar, or oci-archive.");
  }

  const policyPath = policyInput ? resolveTarget(policyInput, workspace) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const [kind, rawTarget] = selected[0];
  const target = resolveTarget(rawTarget, workspace);

  const findings = kind === "directory"
    ? inspectDirectory(target, { policy })
    : kind === "tar"
      ? await inspectTarArchive(target, { policy })
      : await inspectOciArchive(target, { policy });

  for (const item of findings) {
    console.error(`::error::${item.where}: ${item.kind} (${item.detail})`);
  }
  if (findings.length > 0) {
    throw new Error(`Artifact contains ${findings.length} AI-coding trace(s).`);
  }
  console.log(`Artifact (${kind}) passed trace inspection with 0 findings.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("::error::" + String(error.message).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A"));
    process.exitCode = 1;
  });
}
