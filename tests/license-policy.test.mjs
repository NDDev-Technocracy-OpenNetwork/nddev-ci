import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/security.yml", import.meta.url), "utf8");
const defaults = workflow.match(/^      LICENSES: (.+)$/m)[1];
const script = workflow.split("      - name: Licence policy\n")[1].split("        run: |\n")[1]
  .split("      - name:")[0].split("\n").map((line) => line.replace(/^          /, "")).join("\n");

function run(content) {
  const root = mkdtempSync(path.join(tmpdir(), "license-policy-"));
  try {
    if (content !== undefined) writeFileSync(path.join(root, "deny.toml"), content);
    const output = path.join(root, "outputs");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {cwd: root, encoding: "utf8",
      env: {...process.env, POLICY: content === undefined ? "" : "deny.toml", LICENSES: defaults, GITHUB_OUTPUT: output}});
    assert.ifError(result.error);
    return {...result, output: existsSync(output) ? readFileSync(output, "utf8") : ""};
  } finally { rmSync(root, {recursive: true, force: true}); }
}

test("the actual workflow passes the complete default list without admitting LGPL or GPL", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, `licenses=${defaults}\n`);
  const list = defaults.split(",");
  for (const license of ["MIT-0", "0BSD", "Apache-2.0 WITH LLVM-exception", "CDLA-Permissive-2.0", "MPL-2.0", "EPL-2.0", "Unlicense"])
    assert.ok(list.includes(license));
  assert.ok(!list.some((license) => /^(?:A?GPL|LGPL)-/.test(license)));
});

test("a caller policy keeps an SPDX WITH exception as one exact license entry", () => {
  const result = run('[licenses]\nallow = ["MIT", "Apache-2.0 WITH LLVM-exception"]\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "licenses=MIT,Apache-2.0 WITH LLVM-exception\n");
});

test("invalid, duplicate and newline-bearing policies fail instead of selecting defaults", () => {
  for (const allow of ['[]', '["MIT", "MIT"]', '["MIT\\nISC"]', '["MIT WITH"]', '["MIT OR Apache-2.0"]']) {
    const result = run(`[licenses]\nallow = ${allow}\n`);
    assert.notEqual(result.status, 0, allow);
    assert.equal(result.output, "");
  }
});
