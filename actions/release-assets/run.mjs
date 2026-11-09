import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { managedRunner } from "../../lib/runner-profile.mjs";
import {
  ActionError,
  downloadAsset,
  validateAsset,
} from "../../lib/release-asset.mjs";
import {
  filename,
  members,
  matches,
  extract,
} from "../../lib/native-member.mjs";

const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

function destinationDirectory(requested, roots) {
  let ancestor = requested;
  while (!existsSync(ancestor)) {
    // A dangling symlink must not become a directory through recursive mkdir.
    try {
      if (lstatSync(ancestor).isSymbolicLink())
        throw new ActionError("Asset destination contains a dangling symlink.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    ancestor = path.dirname(ancestor);
  }
  const physical = realpathSync(ancestor);
  if (!roots.some((root) => within(root, physical)))
    throw new ActionError(
      "Asset destination resolves outside runner-owned directories.",
    );
  const directory = path.resolve(physical, path.relative(ancestor, requested));
  mkdirSync(directory, { recursive: true });
  return realpathSync(directory);
}

export async function main(environment = process.env) {
  if (managedRunner(environment.RUNNER_ENVIRONMENT, environment.INPUT_MANAGED))
    throw new ActionError(
      "Prepared private runners retain their native asset provider.",
    );
  const workspace = realpathSync(environment.GITHUB_WORKSPACE);
  const temporaryRoot = realpathSync(environment.RUNNER_TEMP);
  const manifest = realpathSync(
    path.resolve(workspace, environment.INPUT_MANIFEST),
  );
  if (!within(workspace, manifest))
    throw new ActionError("Asset manifest is outside the checkout.");
  const metadata = lstatSync(manifest);
  if (!metadata.isFile() || metadata.size > 1048576)
    throw new ActionError("Asset manifest must be a bounded regular file.");
  const document = JSON.parse(readFileSync(manifest, "utf8"));
  if (
    document.schema_version !== 1 ||
    !Array.isArray(document.assets) ||
    !document.assets.length
  )
    throw new ActionError("A nonempty versioned asset manifest is required.");
  const names = new Set();
  for (const asset of document.assets) {
    validateAsset(asset);
    filename(asset.file);
    for (const file of [asset, ...members(asset)]) {
      const identity = file.file.toLowerCase();
      if (names.has(identity))
        throw new ActionError(
          "Asset filenames must be unique across archives and native members.",
        );
      names.add(identity);
    }
    if (names.size > 128)
      throw new ActionError(
        "The prepared native file inventory exceeds its bound.",
      );
  }
  const receipt = JSON.stringify({
    schema_version: 1,
    assets: document.assets.map((asset) => ({
      repository: asset.repository,
      asset: asset.asset,
      sha256: asset.sha256,
      files: [asset, ...members(asset)].map((file) => ({
        file: file.file,
        size: file.size,
        sha256: file.sha256,
        executable: file.executable === true,
      })),
    })),
  });
  if (Buffer.byteLength(receipt) > 65536)
    throw new ActionError("The prepared asset receipt exceeds its bound.");
  const addToPath = environment["INPUT_ADD-TO-PATH"] ?? "false";
  if (!["true", "false"].includes(addToPath))
    throw new ActionError("add-to-path must be true or false.");
  if (
    addToPath === "true" &&
    !document.assets.some((asset) =>
      [asset, ...members(asset)].some((file) => file.executable === true),
    )
  )
    throw new ActionError(
      "Adding native tools to PATH requires an explicitly executable pinned file.",
    );
  if (
    typeof environment.INPUT_DIRECTORY !== "string" ||
    /[\r\n\0]/.test(environment.INPUT_DIRECTORY)
  )
    throw new ActionError("Asset destination must be a single-line path.");
  const requested = path.resolve(workspace, environment.INPUT_DIRECTORY);
  const directory = destinationDirectory(requested, [workspace, temporaryRoot]);
  for (const asset of document.assets) {
    const target = path.join(directory, asset.file);
    const current = matches(target, asset);
    const staging = mkdtempSync(path.join(directory, ".asset-"));
    try {
      const source = path.join(staging, asset.file);
      if (!current) {
        await downloadAsset(asset, source, environment["INPUT_GITHUB-TOKEN"], environment.NDDEV_CI_ARTIFACT_REGISTRY);
        if (asset.executable === true) chmodSync(source, 0o755);
        renameSync(source, target);
      } else if (asset.executable === true) chmodSync(target, 0o755);
      for (const member of members(asset)) {
        const installed = path.join(directory, member.file);
        if (matches(installed, member)) {
          if (member.executable === true) chmodSync(installed, 0o755);
          continue;
        }
        const extracted = path.join(staging, member.file);
        await extract(target, member, extracted);
        if (member.executable === true) chmodSync(extracted, 0o755);
        renameSync(extracted, installed);
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  if (addToPath === "true" && environment.GITHUB_PATH)
    appendFileSync(environment.GITHUB_PATH, `${directory}\n`);
  if (environment.GITHUB_OUTPUT)
    appendFileSync(
      environment.GITHUB_OUTPUT,
      `directory=${directory}\nreceipt=${receipt}\n`,
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      `::error::${error instanceof ActionError ? error.message : "Release asset preparation failed."}`,
    );
    process.exitCode = 1;
  });
