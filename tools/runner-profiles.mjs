import { readFileSync, writeFileSync } from "node:fs";
import { entryLabels, hostedLabels, profileHostedLabels } from "../lib/runner-profile.mjs";

const work = "inputs.runner-profile";
const nonLinux = "(inputs.runner-profile == 'macos-arm64' || inputs.runner-profile == 'windows-x64')";
const helper = "(inputs.runner == 'nddev-macos' && 'linux-arm64' || " +
  nonLinux + " && 'linux-x64' || inputs.runner-profile || " +
  "inputs.runner == 'nddev-linux-arm64' && 'linux-arm64' || " +
  "(inputs.runner == 'nddev-linux-standart' || inputs.runner == 'nddev-linux-small') && 'linux-x64' || '')";
const lightRunner = "(inputs.runner == 'nddev-macos' && 'nddev-linux-arm64' || " +
  "(inputs.runner == 'nddev-linux-standart' || " + nonLinux + ") && 'nddev-linux-small' || inputs.runner)";

const defaultImage = "'" + profileHostedLabels["linux-x64"] + "'";
const privateRepo = "github.event.repository.private";
const dispatch = "github.event_name == 'workflow_dispatch' && github.event.inputs.runner == 'github'";
const dispatchProfile = "github.event.inputs['runner-profile']";
const labels = "github.event.pull_request.labels.*.name";
const manual = "(contains(" + labels + ", 'runner:github') || (" + dispatch + " && " + dispatchProfile + " == ''))";
const image = (profile) => "fromJSON('" + JSON.stringify(profileHostedLabels) + "')[" + profile + "]";

function route(file, { profile = work, managed = "inputs.runner", recipe = false } = {}) {
  const matchesLabel = "contains(" + labels + ", format('runner:github:{0}', " + profile + "))";
  const matchesDispatch = "(" + dispatch + " && " + dispatchProfile + " == " + profile + ")";
  const scoped = "(" + profile + " != '' && (" + matchesLabel + " || " + matchesDispatch + "))";
  const labelsForPublic = JSON.stringify(hostedLabels[entryLabels[file]]);
  const configured = "contains(fromJSON('" + labelsForPublic + "'), inputs.hosted-runner) && inputs.hosted-runner";
  const publicImage = recipe
    ? "(inputs.hosted-runner == '' && (" + image(profile) + " || " + defaultImage + ") || " + configured + ")"
    : "(" + configured + " || " + defaultImage + ")";
  // Keep an invalid explicit hosted label from sending a public or manually hosted recipe to
  // a managed runner.
  const managedRoute = recipe ? "!" + manual + " && " + managed : managed;
  const legacyImage = recipe ? publicImage : defaultImage;
  return [
    "$" + "{{",
    "!" + privateRepo + " && " + publicImage,
    "|| " + privateRepo + " && (",
    "  " + scoped + " && " + image(profile),
    "  || " + manual + " && (" + image(profile) + " || " + legacyImage + ")",
    "  || " + managedRoute,
    ") || ''",
    "}}",
  ].map((line) => "      " + line).join("\n");
}

const paths = {
  "check.yml": { plan: { profile: helper, managed: lightRunner }, check: {}, join: { profile: helper, managed: lightRunner } },
  "merge-stops.yml": { stops: { profile: helper, managed: lightRunner } },
  "recipe.yml": { recipe: { recipe: true } },
};
const marked = /(^    # runner-profile:(\S+)\n)    runs-on:[^\n]*(?:\n      [^\n]+)*/gm;

const mode = process.argv[2];
if (!["--check", "--write"].includes(mode) || process.argv.length !== 3)
  throw new Error("usage: node tools/runner-profiles.mjs --check|--write");

for (const [file, jobs] of Object.entries(paths)) {
  const url = new URL("../.github/workflows/" + file, import.meta.url);
  const before = readFileSync(url, "utf8");
  const found = new Set();
  const after = before.replace(marked, (_, marker, job) => {
    if (!Object.hasOwn(jobs, job) || found.has(job)) throw new Error("Unexpected runner profile marker: " + file + " " + job);
    found.add(job);
    return marker + "    runs-on: >-\n" + route(file, jobs[job]);
  });
  if (found.size !== Object.keys(jobs).length) throw new Error("Missing runner profile marker: " + file);
  if (before === after) continue;
  if (mode === "--check") throw new Error("Runner profiles differ in " + file + ". Run just fix.");
  writeFileSync(url, after);
}
