import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { warmUvCaches } from "../../lib/uv-cache.mjs";

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  Promise.resolve()
    .then(() => warmUvCaches(process.env, console.log))
    .catch((err) => console.log(`::warning::Skipped uv wheel cache warming: ${String(err.message)}`));
}
