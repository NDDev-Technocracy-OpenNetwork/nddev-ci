import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findings } from "../../lib/build-conventions.mjs";

export function main(environment = process.env, log = console.log) {
  const found = findings(realpathSync(environment.GITHUB_WORKSPACE));
  for (const { path: file, line, message } of found)
    log(`::warning file=${file},line=${line}::${message}`);
  if (!found.length) log("Every tracked build line keeps the runner's conventions.");
  return found.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { console.error("::warning::The build conventions were not read: " + String(error.message)); }
}
