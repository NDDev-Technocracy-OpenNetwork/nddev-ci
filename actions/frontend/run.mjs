import { prepareFrontend } from "../recipe/run.mjs";
import { ActionError } from "../../lib/release-asset.mjs";

prepareFrontend().catch((error) => {
  console.error(
    `::error::${error instanceof ActionError ? error.message : "The native task runner could not be prepared."}`,
  );
  process.exitCode = 1;
});
