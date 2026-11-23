import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { entryLabels, hostedLabels, profileHostedLabels } from "../lib/runner-profile.mjs";

const folder = new URL("../.github/workflows/", import.meta.url);
const read = (name) => readFileSync(new URL(name, folder), "utf8");

// The label arrays inside a workflow's runs-on expressions and its `case` label checks.
function lists(text) {
  const arrays = [...text.matchAll(/fromJSON\('(\[[^\]]*\])'\)/g)].map((match) => JSON.parse(match[1]));
  const cases = [...text.matchAll(/^\s*(?:case "\$HOSTED_RUNNER" in )?((?:[a-z0-9.-]+ \| )+[a-z0-9.-]+)\) ;;/gm)]
    .map((match) => match[1].split(" | "));
  return {arrays, cases};
}

test("every entry point's hosted labels are the module's list", () => {
  for (const [name, kind] of Object.entries(entryLabels)) {
    const {arrays, cases} = lists(read(name));
    assert.ok(arrays.length > 0, `${name} has no label list in runs-on`);
    for (const list of [...arrays, ...cases]) assert.deepEqual(list, hostedLabels[kind], name);
  }
});

test("no other workflow chooses among hosted labels", () => {
  for (const name of readdirSync(folder)) {
    if (Object.hasOwn(entryLabels, name)) continue;
    assert.equal(lists(read(name)).arrays.length, 0, `${name} lists hosted labels; add it to entryLabels`);
  }
});

test("recipe.yml describes exactly the labels it accepts", () => {
  const description = read("recipe.yml").split("      hosted-runner:")[1].split("type:")[0];
  for (const label of hostedLabels.recipe) assert.match(description, new RegExp(`\\b${label.replace(".", "\\.")}\\b`));
});

function route(file, job) {
  const block = read(file).split("# runner-profile:" + job + "\n    runs-on: >-\n")[1].split(/\n    \S/)[0];
  const expression = block.trim().slice(3, -2)
    .replaceAll("github.event.pull_request.labels.*.name", "github.event.pull_request.labels")
    .replaceAll("inputs.runner-profile", "inputs['runner-profile']")
    .replaceAll("inputs.hosted-runner", "inputs['hosted-runner']");
  // The emitted expressions use only these three actions primitives and boolean selection.
  const evaluate = new Function("github", "inputs", "contains", "format", "fromJSON", "return (" + expression + ")");
  return ({ labels = [], target = "", provider = "github", event = "pull_request",
    profile = "", runner = "managed-example", hosted = "", privateRepo = true,
    actor = "developer", triggeringActor = actor, sender = "User", author = "User",
  } = {}) => evaluate({
    actor,
    triggering_actor: triggeringActor,
    event_name: event,
    event: {
      repository: { private: privateRepo },
      sender: { type: sender },
      pull_request: { labels: event === "pull_request" ? labels : [], user: { type: author } },
      inputs: { runner: provider, "runner-profile": target },
    },
  }, { runner, "runner-profile": profile, "hosted-runner": hosted },
  (values, value) => values.includes(value), (form, value) => form.replace("{0}", value), JSON.parse);
}

test("a scoped restart moves just the matching work to the same platform", () => {
  const check = route("check.yml", "check");
  const recipe = route("recipe.yml", "recipe");
  for (const [target, image] of Object.entries(profileHostedLabels)) {
    for (const event of ["pull_request", "workflow_dispatch"]) {
      for (const profile of Object.keys(profileHostedLabels)) {
        const args = { labels: ["runner:github:" + target], target, event, profile };
        for (const select of [check, recipe])
          assert.equal(select(args), profile === target ? image : "managed-example", event + " " + profile + " " + target);
      }
    }
  }
  for (const select of [check, recipe]) {
    assert.equal(select({labels:["runner:github:mismatched"], profile:"mismatched"}), "managed-example");
    assert.equal(select({labels:["runner:github:macos-arm64"]}), "managed-example");
    assert.equal(select({event:"workflow_dispatch", provider:"ours", target:"macos-arm64", profile:"macos-arm64"}), "managed-example");
    assert.equal(select({event:"workflow_dispatch", target:"mismatched", profile:"mismatched"}), "managed-example");
    const labels = ["runner:github:macos-arm64", "runner:github:windows-x64"];
    assert.equal(select({labels, profile:"windows-x64"}), profileHostedLabels["windows-x64"]);
    assert.equal(select({labels, profile:"linux-x64"}), "managed-example");
  }
});

test("light jobs follow their own Linux class", () => {
  for (const [file, job] of [["check.yml", "plan"], ["check.yml", "join"], ["merge-stops.yml", "stops"]]) {
    const select = route(file, job);
    const mac = {runner:"nddev-macos", profile:"macos-arm64"};
    assert.equal(select({...mac, labels:["runner:github:macos-arm64"]}), "nddev-linux-arm64");
    assert.equal(select({...mac, labels:["runner:github:linux-arm64"]}), profileHostedLabels["linux-arm64"]);
    const windows = {runner:"example-windows", profile:"windows-x64"};
    assert.equal(select({...windows, target:"windows-x64", event:"workflow_dispatch"}), "nddev-linux-small");
    assert.equal(select({...windows, target:"linux-x64", event:"workflow_dispatch"}), profileHostedLabels["linux-x64"]);
    assert.equal(select({runner:"nddev-linux-standart", profile:"linux-x64"}), "nddev-linux-small");
  }
});

test("public and unqualified manual selection preserve their routes", () => {
  const recipe = route("recipe.yml", "recipe");
  assert.equal(recipe({privateRepo:false, profile:"macos-arm64"}), profileHostedLabels["macos-arm64"]);
  assert.equal(recipe({privateRepo:false, hosted:"macos-26", profile:"macos-arm64"}), "macos-26");
  assert.equal(recipe({privateRepo:false, hosted:"managed-example", labels:["runner:github:macos-arm64"], profile:"macos-arm64"}), "");
  for (const args of [{labels:["runner:github"]}, {event:"workflow_dispatch"}]) {
    assert.equal(recipe({...args, profile:"windows-x64"}), profileHostedLabels["windows-x64"]);
    assert.equal(recipe({...args, hosted:"macos-26"}), "macos-26");
    assert.equal(recipe({...args, hosted:"managed-example"}), "");
  }
});

test("bot-only private Linux PR checks use the maintenance lane", () => {
  const check = route("check.yml", "check");
  const recipe = route("recipe.yml", "recipe");
  const mergeStops = route("merge-stops.yml", "stops");
  const registry = route("check.yml", "registry");
  const bot = { actor: "renovate[bot]", author: "Bot", sender: "Bot", profile: "linux-x64" };
  for (const runner of ["nddev-linux-small", "nddev-linux-standart"]) {
    for (const select of [check, recipe]) {
      assert.equal(select({ ...bot, runner }), runner + "-maintenance");
      assert.equal(select({ ...bot, runner, triggeringActor: "developer" }), runner);
      assert.equal(select({ ...bot, runner, sender: "User", actor: "developer" }), runner);
      assert.equal(select({ ...bot, runner, author: "User" }), runner);
      assert.equal(select({ ...bot, runner, event: "push" }), runner);
      assert.equal(select({ ...bot, runner, event: "release" }), runner);
      assert.equal(select({ ...bot, runner, event: "workflow_dispatch", provider: "ours" }), runner);
      assert.equal(select({ ...bot, runner, labels: ["runner:github:linux-x64"] }), "ubuntu-24.04");
      assert.equal(select({ ...bot, runner, privateRepo: false }), "ubuntu-24.04");
    }
    assert.equal(mergeStops({ ...bot, runner }), "nddev-linux-small-maintenance");
    assert.equal(mergeStops({ ...bot, runner, triggeringActor: "developer" }), "nddev-linux-small");
  }
  assert.equal(check({ ...bot, runner: "nddev-linux-arm64" }), "nddev-linux-arm64");
  assert.equal(registry(bot), "nddev-linux-small-maintenance");
  assert.equal(registry({ ...bot, event: "push" }), "nddev-linux-small");
});
