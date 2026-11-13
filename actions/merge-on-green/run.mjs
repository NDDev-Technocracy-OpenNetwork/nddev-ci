import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { client } from "../../lib/qualification.mjs";
import { selectMerge } from "../../lib/merge-on-green.mjs";

export async function main(environment = process.env) {
  const input = (name) => environment[`INPUT_${name.toUpperCase()}`] || "";
  const token = input("github-token");
  if (!token) throw new Error("A read token is required to choose the pull request.");
  const result = await selectMerge(client(token, environment.GITHUB_API_URL), {
    repository: environment.GITHUB_REPOSITORY, sha: input("sha"),
    label: input("label") || "merge-on-green", self: input("self") || "merge on green",
  });
  appendFileSync(environment.GITHUB_OUTPUT,
    `state=${result.state}\nnumber=${result.number ?? ""}\nbase=${result.base ?? ""}\nhead=${result.head ?? ""}\n`);
  console.log(result.state === "ready" ? `Merging pull request #${result.number} into ${result.base}.`
    : result.state === "none" ? "No labelled pull request has this commit as its head."
    : `Not merging yet: ${result.state}, ${result.reason}.`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => { console.error(`::error::${error.message.replace(/[\r\n%]/g, " ")}`); process.exitCode = 1; });
