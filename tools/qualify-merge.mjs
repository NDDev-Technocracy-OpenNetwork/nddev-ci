#!/usr/bin/env node
import { selectMerge } from "../lib/merge-on-green.mjs";
import { client } from "../lib/qualification.mjs";

const [repository, number, sha, base, ...checks] = process.argv.slice(2);
const token = process.env.GH_TOKEN;

try {
  if (!repository || !/^[1-9][0-9]*$/.test(number ?? "") || !sha || !base || !checks.length)
    throw new Error("Usage: node tools/qualify-merge.mjs <repository> <pull-number> <sha> <base> <check> [<check> ...]");
  if (!token) throw new Error("GH_TOKEN must provide read access to the repository, pull request, checks and statuses.");
  if (checks.some((name) => /[\r\n]/.test(name)))
    throw new Error("Pass each mandatory check as a separate argument.");

  const { title, ...result } = await selectMerge(client(token, process.env.GITHUB_API_URL), {
    repository, sha, pullNumber: Number(number), base,
    requiredChecks: checks.join("\n"),
    self: "merge on green",
  });
  console.log(JSON.stringify({repository, sha, ...result}));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
