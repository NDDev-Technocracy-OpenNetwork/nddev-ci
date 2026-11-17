import { rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const directory = process.env.STATE_registry_snapshot_directory;
if (directory) {
  if (!process.env.RUNNER_TEMP || dirname(directory) !== resolve(process.env.RUNNER_TEMP) ||
      !/^contour-registry-[A-Za-z0-9]+$/.test(basename(directory))) {
    throw new Error("Registry input cleanup escaped its job directory.");
  }
  for (const remove of [
    () => unlinkSync(join(directory, "registry.json")),
    () => rmdirSync(directory),
  ]) {
    try { remove(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
