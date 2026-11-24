import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionError } from "../../lib/release-asset.mjs";

export async function runStep(step, environment = process.env) {
  if (step === "validate" || step === "verify") {
    const { main } = await import("../hosted-sdk/run.mjs");
    return main(step, environment);
  }
  if (step === "bun") {
    const { main } = await import("../hosted-sdk/bun.mjs");
    return await main(environment);
  }
  if (step === "flutter") {
    const { install } = await import("../hosted-sdk/flutter.mjs");
    return await install(environment);
  }
  if (step === "dart") {
    const { install } = await import("../hosted-sdk/dart.mjs");
    return await install(environment);
  }
  throw new ActionError("Unknown hosted SDK helper step.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runStep(process.env.INPUT_STEP);
  } catch (error) {
    console.error(`::error::${error instanceof ActionError ? error.message : "Hosted SDK step failed."}`);
    process.exitCode = 1;
  }
}
