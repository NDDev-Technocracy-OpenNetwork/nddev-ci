#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { beforePush } from "../lib/verify-parts.mjs";

try {
  const source = spawnSync("just", ["--dump", "--dump-format", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  });
  if (source.error || source.status !== 0) throw new Error("Could not read the project's justfile.");
  const dump = JSON.parse(source.stdout);
  const recipes = beforePush(dump);
  if (recipes.length) {
    const args = dump.recipes.setup ? ["setup", ...recipes] : recipes;
    const execution = spawnSync("just", args, { stdio: "inherit" });
    if (execution.error || execution.status === null) throw new Error("The pre-push check did not finish.");
    process.exitCode = execution.status;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
