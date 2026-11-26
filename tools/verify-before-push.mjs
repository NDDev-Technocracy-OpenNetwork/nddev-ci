#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { receive, send, sendManaged } from "../lib/pre-push-executor.mjs";
import { beforePush } from "../lib/verify-parts.mjs";

function verify(cwd = process.cwd(), env = process.env) {
  const source = spawnSync("just", ["--dump", "--dump-format", "json"], {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  });
  if (source.error || source.status !== 0) throw new Error("Could not read the project's justfile.");
  const dump = JSON.parse(source.stdout);
  const recipes = beforePush(dump);
  if (!recipes.length) return 0;

  const args = dump.recipes.setup ? ["setup", ...recipes] : recipes;
  const execution = spawnSync("just", args, { cwd, env, stdio: "inherit" });
  if (execution.error || execution.status === null) throw new Error("The pre-push check did not finish.");
  return execution.status;
}

try {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "--send" && args.length === 3) {
    await send(...args, readFileSync(0, "utf8"));
  } else if (operation === "--send-managed" && args.length === 5) {
    await sendManaged(...args, readFileSync(0, "utf8"));
  } else if (operation === "--receive" && args.length === 4) {
    process.exitCode = await receive(...args, verify);
  } else if (operation === undefined) {
    process.exitCode = verify();
  } else {
    throw new Error("Invalid pre-push verification command.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
