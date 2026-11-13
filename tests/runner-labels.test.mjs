import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { entryLabels, hostedLabels } from "../lib/runner-profile.mjs";

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
