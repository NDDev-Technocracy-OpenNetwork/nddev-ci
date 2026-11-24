import path from "node:path";
import { pathToFileURL } from "node:url";
import { warmUvCaches } from "../../lib/uv-cache.mjs";

export function main(environment = process.env, log = console.log) {
  return warmUvCaches(environment, log);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.log(`::warning::Skipped uv wheel cache warming: ${String(error.message)}`);
  }
}
