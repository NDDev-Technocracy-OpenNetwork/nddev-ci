import path from "node:path";
import { pathToFileURL } from "node:url";
import { scanHistory } from "../../lib/secret-scan.mjs";

export function main(environment = process.env) {
  const base = environment.INPUT_BASE;
  const head = environment.INPUT_HEAD;
  scanHistory(environment, {base, tips: [head], excludes: [base]});
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    console.error(`::error::${String(error.message).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
