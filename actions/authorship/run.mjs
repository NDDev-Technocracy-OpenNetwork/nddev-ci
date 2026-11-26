import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "../../lib/authorship.mjs";

function stripHeads(ref) {
  return String(ref ?? "").replace(/^refs\/heads\//, "");
}

export function main(environment = process.env) {
  const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, "utf8"));
  const request = event.pull_request ?? (event.merge_group
    ? {
      title: "",
      body: "",
      base: { ref: stripHeads(event.merge_group.base_ref) },
      head: { ref: stripHeads(event.merge_group.head_ref) },
    }
    : null);
  if (!request) throw new Error("Authorship inspection requires a pull request or merge group event.");
  const problems = inspect(realpathSync(environment.GITHUB_WORKSPACE), {
    base: environment.INPUT_BASE,
    head: environment.INPUT_HEAD,
    upstreamBranch: environment["INPUT_UPSTREAM-BRANCH"],
    request,
  });
  for (const { where, line } of problems)
    console.error("::error::" + where + ":" + line + ": remove generated assistant attribution.");
  if (problems.length) throw new Error("Generated assistant attribution must be removed before merge.");
  console.log("Introduced commits and pull request text pass authorship inspection.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) {
    console.error("::error::" + String(error.message).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A"));
    process.exitCode = 1;
  }
}
