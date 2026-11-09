import { appendFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { client, receipt, transferArtifacts } from "../../lib/qualification.mjs";

export async function main(environment = process.env) {
  const input = (name) => environment[`INPUT_${name.toUpperCase()}`] || "";
  const root = realpathSync(environment.RUNNER_TEMP);
  const directory = path.resolve(root, input("directory") || "checked-artifacts");
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) ||
      existsSync(directory) || path.dirname(directory) !== root)
    throw new Error("Artifact destination must be a new direct child of RUNNER_TEMP.");
  let qualified;
  try { qualified = receipt(JSON.parse(input("receipt"))); }
  catch { throw new Error("A valid qualification receipt is required."); }
  if (!input("github-token")) throw new Error("A metadata read token is required.");
  const result = await transferArtifacts(client(input("github-token"), input("api-url") || environment.GITHUB_API_URL),
    qualified, input("artifacts"), directory, {apiUrl: input("artifact-api-url"), token: input("artifact-token")});
  appendFileSync(environment.GITHUB_OUTPUT, `directory=${directory}\nmanifest=${JSON.stringify(result)}\n`);
  console.log(`Transferred ${result.artifacts.length} artifacts and verified ${result.files.length} files.`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => { console.error(`::error::${error.message.replace(/[\r\n%]/g, " ")}`); process.exitCode = 1; });
