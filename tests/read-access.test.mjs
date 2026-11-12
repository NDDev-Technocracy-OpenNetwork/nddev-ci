import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The private source reads of check.yml and recipe.yml are one interface: the same steps, word for
// word, apart from recipe.yml naming bash for runners whose default shell differs.
function steps(workflow) {
  const text = readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8");
  const found = {};
  for (const name of ["Read keys", "Scoped App read token", "App Git credentials", "Revoke App read token"]) {
    const start = text.indexOf(`      - name: ${name}\n`);
    assert.notEqual(start, -1, `${workflow} has no step ${name}`);
    let end = text.indexOf("\n      - name: ", start + 1);
    if (end === -1) end = text.indexOf("\n\n  ", start);
    found[name] = text.slice(start, end).trimEnd().split("\n")
      .filter((line) => line !== "        shell: bash").join("\n");
  }
  return found;
}

function inputs(workflow) {
  const text = readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8");
  const start = text.indexOf("      read-app-client-id:\n");
  const end = text.indexOf("      read-repositories:\n", start);
  const after = text.indexOf("        default:", end);
  const secrets = text.slice(text.indexOf("    secrets:\n"), text.indexOf("\npermissions:"));
  return [text.slice(start, text.indexOf("\n", after)), secrets.trimEnd()];
}

test("recipe.yml reads private sources with check.yml's steps", () => {
  const check = steps("check.yml");
  const recipe = steps("recipe.yml");
  for (const name of Object.keys(check)) assert.equal(recipe[name], check[name], name);
});

test("recipe.yml takes check.yml's read inputs and secrets", () => {
  assert.deepEqual(inputs("recipe.yml"), inputs("check.yml"));
});
