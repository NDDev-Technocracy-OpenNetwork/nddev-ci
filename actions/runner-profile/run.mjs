import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { managedRunner } from "../../lib/runner-profile.mjs";

export function main(environment = process.env) {
  const external = environment.INPUT_EXTERNAL || "false";
  if (!["true", "false"].includes(external)) throw new Error("external must be true or false.");
  const managed = managedRunner(environment.RUNNER_ENVIRONMENT, external === "true" ? "false" : "");
  appendFileSync(environment.GITHUB_OUTPUT, `managed=${managed}\nbootstrap=${!managed}\n`);
  console.log(`Runner SDK profile: ${managed ? "managed" : "external bootstrap"}.`);
  return managed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try { main(); } catch (error) { console.error(`::error::${error.message}`); process.exitCode = 1; }
