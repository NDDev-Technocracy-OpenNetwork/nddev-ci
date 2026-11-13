import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { client } from "../../lib/qualification.mjs";
import { selectPromotion } from "../../lib/promotion.mjs";

export async function main(environment = process.env) {
  const input = (name) => environment[`INPUT_${name.toUpperCase()}`] || "";
  const token = input("github-token");
  if (!token) throw new Error("A read token is required to choose the commit.");
  const result = await selectPromotion(client(token, environment.GITHUB_API_URL), {
    repository: environment.GITHUB_REPOSITORY,
    workflowPath: `.github/workflows/${input("check-workflow") || "ci.yml"}`,
    source: input("source-branch") || "dev", target: input("target-branch") || "main",
  });
  for (const {sha, state, reason} of result.skipped ?? []) console.log(`Passed over ${sha}: ${state}. ${reason}`);
  appendFileSync(environment.GITHUB_OUTPUT, `state=${result.state}\nsha=${result.sha ?? ""}\n`);
  console.log(result.state === "ready" ? `Promoting ${result.sha}, checked by run ${result.run_id}.`
    : result.state === "current" ? "Nothing new to promote." : "No new commit has a passed check yet.");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => { console.error(`::error::${error.message.replace(/[\r\n%]/g, " ")}`); process.exitCode = 1; });
