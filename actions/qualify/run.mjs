import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { client, qualifyWorkflows } from "../../lib/qualification.mjs";

export async function main(environment = process.env) {
  const input = (name) => environment[`INPUT_${name.toUpperCase()}`] || "";
  const token = input("github-token");
  if (!token) throw new Error("A read token is required for qualification.");
  const [result] = await qualifyWorkflows(
    client(token, input("api-url") || environment.GITHUB_API_URL, {retryReads: true}),
    {
      repository: input("repository") || environment.GITHUB_REPOSITORY,
      sha: input("commit") || environment.GITHUB_SHA,
      workflowPath: `.github/workflows/${input("check-workflow") || "ci.yml"}`,
      branch: input("check-branch") || "dev", event: input("check-event") || "push",
    },
    input("required-workflows"),
    {waitMinutes: Number(input("wait-minutes") || "30")},
  );
  appendFileSync(environment.GITHUB_OUTPUT, `receipt=${JSON.stringify(result)}\n`);
  console.log(`Qualified ${result.sha} by run ${result.run_id}, attempt ${result.run_attempt}.`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => { console.error(`::error::${error.message.replace(/[\r\n%]/g, " ")}`); process.exitCode = 1; });
