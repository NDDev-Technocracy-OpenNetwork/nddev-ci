import { readFileSync, writeFileSync } from "node:fs";
import { entryLabels, hostedLabels, profileHostedLabels } from "../lib/runner-profile.mjs";

const work = "inputs.runner-profile";
const nonLinux = "(inputs.runner-profile == 'macos-arm64' || inputs.runner-profile == 'windows-x64')";
const helper = "(inputs.runner == 'nddev-macos' && 'linux-arm64' || " +
  nonLinux + " && 'linux-x64' || inputs.runner-profile || " +
  "inputs.runner == 'nddev-linux-arm64' && 'linux-arm64' || " +
  "(inputs.runner == 'nddev-linux-standart' || inputs.runner == 'nddev-linux-small' || inputs.runner == 'nddev-linux-light' || inputs.runner == 'nddev-linux-release') && 'linux-x64' || '')";
const lightRunner = "((inputs.runner == 'nddev-macos' || inputs.runner == 'nddev-linux-standart' || inputs.runner == 'nddev-linux-small' || " +
  nonLinux + ") && 'nddev-linux-light' || inputs.runner)";
const partRunner = "(fromJSON(inputs['part-runners'])[matrix.part.group] || inputs.runner)";

const defaultImage = "'" + profileHostedLabels["linux-x64"] + "'";
const privateRepo = "github.event.repository.private";
const dispatch = "github.event_name == 'workflow_dispatch' && github.event.inputs.runner == 'github'";
const dispatchProfile = "github.event.inputs['runner-profile']";
const labels = "github.event.pull_request.labels.*.name";
const manual = "(contains(" + labels + ", 'runner:github') || (" + dispatch + " && " + dispatchProfile + " == ''))";
const image = (profile) => "fromJSON('" + JSON.stringify(profileHostedLabels) + "')[" + profile + "]";

const botPullRequest = [
  "github.event_name == 'pull_request'",
  "github.event.sender.type == 'Bot'",
  "github.event.pull_request.user.type == 'Bot'",
  "github.actor == github.triggering_actor",
].join(" && ");
const maintenanceLabels = {
  "nddev-linux-bounded": "nddev-linux-bounded-maintenance",
  "nddev-linux-light": "nddev-linux-light-maintenance",
  "nddev-linux-small": "nddev-linux-small-maintenance",
  "nddev-linux-standart": "nddev-linux-standart-maintenance",
  "nddev-macos": "nddev-macos-maintenance",
  "nddev-windows": "nddev-windows-maintenance",
};

function maintenanceRunner(managed) {
  const lane = "fromJSON('" + JSON.stringify(maintenanceLabels) + "')[" + managed + "]";
  return "(" + botPullRequest + " && " + lane + " || " + managed + ")";
}

function route(file, {
  profile = work, managed = "inputs.runner", recipe = false, maintenance = false, managedOnly = false,
} = {}) {
  const managedLane = maintenance ? maintenanceRunner(managed) : managed;
  if (managedOnly) return ["$" + "{{", managedLane, "}}"].map((line) => "      " + line).join("\n");
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
  const managedRoute = recipe ? "!" + manual + " && " + managedLane : managedLane;
  const legacyImage = recipe ? publicImage : defaultImage;
  return [
    "$" + "{{ !" + privateRepo + " && " + publicImage + " || " + privateRepo + " && (" +
      scoped + " && " + image(profile) + " || " + manual + " && (" + image(profile) + " || " + legacyImage + ")",
    "|| " + managedRoute + ") || '' }}",
  ].map((line) => "      " + line).join("\n");
}

const paths = {
  "check.yml": {
    plan: { profile: helper, managed: lightRunner, maintenance: true },
    registry: { managed: "'nddev-linux-small'", maintenance: true, managedOnly: true },
    check: { managed: partRunner, maintenance: true },
    join: { profile: helper, managed: lightRunner, maintenance: true },
  },
  "merge-stops.yml": { stops: { profile: helper, managed: lightRunner, maintenance: true } },
  "nextest-shards.yml": {
    archive: { maintenance: true },
    shard: { maintenance: true },
  },
  "recipe.yml": { recipe: { recipe: true, maintenance: true } },
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
