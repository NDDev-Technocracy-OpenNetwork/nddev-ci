import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { client } from "../../lib/qualification.mjs";
import { requireStatus } from "../../lib/commit-status.mjs";

export async function main(environment = process.env) {
  const input = (name) => environment[`INPUT_${name.toUpperCase()}`] || "";
  const token = input("github-token");
  if (!token) throw new Error("A repository-scoped status-read token is required.");
  const result = await requireStatus(client(token, environment.GITHUB_API_URL), {
    repository: environment.GITHUB_REPOSITORY, sha: input("sha"), context: input("context"),
    creator: Number(input("creator-id")), maximumStatuses: Number(input("maximum-statuses")),
  });
  if (!environment.GITHUB_OUTPUT) throw new Error("The runner did not provide GITHUB_OUTPUT.");
  appendFileSync(environment.GITHUB_OUTPUT, `state=${result.state}\nsha=${result.sha}\nstatus-id=${result.statusId}\n`);
  console.log(`The trusted readiness context passed on ${result.sha}.`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => { console.error(`::error::${error.message.replace(/[\r\n%]/g, " ")}`); process.exitCode = 1; });
