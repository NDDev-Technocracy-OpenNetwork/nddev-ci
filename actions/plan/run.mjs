import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { matrix, plan } from "../../lib/verify-parts.mjs";

export function main(environment = process.env, dump = () =>
  spawnSync("just", ["--dump", "--dump-format", "json"], {cwd: environment.GITHUB_WORKSPACE, encoding: "utf8", maxBuffer: 64 << 20})) {
  const whole = environment.INPUT_WHOLE || "";
  let result;
  if (whole) result = {split: false, reason: whole, parts: []};
  else {
    const read = dump();
    // A justfile just cannot read runs whole, where `just verify` reports why.
    result = read.error || read.status !== 0 ? {split: false, reason: "the justfile could not be read", parts: []}
      : plan(JSON.parse(read.stdout));
  }
  const jobs = matrix(result);
  appendFileSync(environment.GITHUB_OUTPUT, `split=${result.split}\nmatrix=${JSON.stringify(jobs)}\n`);
  appendFileSync(environment.GITHUB_STEP_SUMMARY, `### The full check: ${result.reason}\n\n` +
    jobs.map((job) => `- \`just ${job.argv.join(" ")}\``).join("\n") + "\n");
  console.log(`The full check: ${result.reason}.`);
  return {result, jobs};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try { main(); } catch (error) { console.error(`::error::${error.message.replace(/[\r\n%]/g, " ")}`); process.exitCode = 1; }
