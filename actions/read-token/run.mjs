import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mint } from "../../lib/read-token.mjs";

export async function main(environment = process.env, fetchImpl = fetch) {
  const input = (name) => environment[`INPUT_${name.toUpperCase()}`] ?? "";
  const privateKey = input("private-key");
  // The key stays out of every child process and later step.
  delete environment["INPUT_PRIVATE-KEY"];
  const {token, count} = await mint({
    clientId: input("client-id"), installationId: input("installation-id"), requested: input("repositories"),
    privateKey, owner: environment.GITHUB_REPOSITORY_OWNER ?? "", api: environment.GITHUB_API_URL ?? "https://api.github.com",
    fetchImpl, mask: (value) => console.log(`::add-mask::${value}`),
  });
  appendFileSync(environment.GITHUB_OUTPUT, `token=${token}\n`);
  console.log(`Scoped contents-read token verified for ${count} repositories.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => { console.error(`::error::${error.message.replace(/[\r\n%]/g, " ")}`); process.exitCode = 1; });
