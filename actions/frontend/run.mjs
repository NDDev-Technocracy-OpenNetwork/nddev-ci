import { prepareFrontend } from "../recipe/run.mjs";

prepareFrontend().catch(() => {
  console.error("::error::The native task runner could not be prepared at its pinned version.");
  process.exitCode = 1;
});
