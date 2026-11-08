import { createHash } from "node:crypto";
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
import {
  ActionError,
  downloadAsset,
  validateAsset,
} from "../../lib/release-asset.mjs";

const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

function destinationDirectory(requested, roots) {
  if (!roots.some((root) => within(root, requested)))
    throw new ActionError(
      "Asset destination is outside runner-owned directories.",
    );
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
  if (environment.RUNNER_ENVIRONMENT !== "github-hosted")
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
  if (lstatSync(manifest).size > 1048576)
    throw new ActionError("Asset manifest exceeds its size limit.");
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
    if (
      typeof asset.file !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(asset.file) ||
      names.has(asset.file)
    )
      throw new ActionError("Asset filenames must be unique basenames.");
    names.add(asset.file);
  }
  const requested = path.resolve(workspace, environment.INPUT_DIRECTORY);
  const directory = destinationDirectory(requested, [workspace, temporaryRoot]);
  for (const asset of document.assets) {
    const target = path.join(directory, asset.file);
    let current;
    try {
      current = lstatSync(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current) {
      if (!current.isFile())
        throw new ActionError("Asset destination is not a regular file.");
      if (
        current.size === asset.size &&
        createHash("sha256").update(readFileSync(target)).digest("hex") ===
          asset.sha256
      ) {
        if (asset.executable === true) chmodSync(target, 0o755);
        continue;
      }
    }
    const staging = mkdtempSync(path.join(directory, ".asset-"));
    try {
      const source = path.join(staging, asset.file);
      await downloadAsset(asset, source, environment["INPUT_GITHUB-TOKEN"]);
      if (asset.executable === true) chmodSync(source, 0o755);
      renameSync(source, target);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  if (environment.GITHUB_OUTPUT)
    appendFileSync(environment.GITHUB_OUTPUT, `directory=${directory}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      `::error::${error instanceof ActionError ? error.message : "Release asset preparation failed."}`,
    );
    process.exitCode = 1;
  });
