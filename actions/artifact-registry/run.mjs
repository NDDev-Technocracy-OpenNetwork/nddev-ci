import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function registry(environment) {
  const value = environment.INPUT_URL || environment.NDDEV_CI_ARTIFACT_REGISTRY || "";
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch { throw new Error("Artifact registry must be an absolute HTTP(S) URL."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
      /[\s\0]/.test(value))
    throw new Error("Artifact registry must be an HTTP(S) base URL without credentials, query or fragment.");
  return url.href.replace(/\/$/, "");
}

export function main(environment = process.env) {
  const url = registry(environment);
  if (environment.GITHUB_ENV)
    appendFileSync(environment.GITHUB_ENV, `NDDEV_CI_ARTIFACT_REGISTRY=${url}\n`);
  console.log(url ? "Tool downloads use the declared artifact registry." : "Tool downloads use official upstream sources.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try { main(); }
  catch (error) { console.error(`::error::${error.message}`); process.exitCode = 1; }
