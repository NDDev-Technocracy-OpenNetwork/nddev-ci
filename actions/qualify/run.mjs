import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { client, qualifyWorkflows } from "../../lib/qualification.mjs";

export async function main(environment = process.env) {
  const token = environment["INPUT_GITHUB-TOKEN"] || "";
  if (!token) throw new Error("A read token is required for qualification.");
  const read = (name, fallback = "") => environment[`INPUT_${name.toUpperCase()}`] || fallback;
  const [result] = await qualifyWorkflows(
    client(token, read("api-url", environment.GITHUB_API_URL), {retryReads: true}),
    {
      repository: read("repository", environment.GITHUB_REPOSITORY),
      sha: read("commit", environment.GITHUB_SHA),
      workflowPath: `.github/workflows/${read("check-workflow", "ci.yml")}`,
      branch: read("check-branch", "dev"),
      event: read("check-event", "push"),
    },
    read("required-workflows"),
    {waitMinutes: Number(read("wait-minutes", "30"))},
  );
  appendFileSync(environment.GITHUB_OUTPUT, `receipt=${JSON.stringify(result)}\n`);
  console.log(`Qualified ${result.sha} by run ${result.run_id}, attempt ${result.run_attempt}.`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => { console.error(`::error::${error.message.replace(/[\r\n%]/g, " ")}`); process.exitCode = 1; });
