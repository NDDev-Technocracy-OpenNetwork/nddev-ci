import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("the actual SDK phase scripts work without a Node SDK on PATH", () => {
  const action = readFileSync(new URL("../actions/hosted-sdk/action.yml", import.meta.url), "utf8");
  const scripts = [...action.matchAll(/        script: \|\n((?:          [^\n]*\n)+)/g)]
    .map((match) => match[1].split("\n").map((line) => line.slice(10)).join("\n"));
  assert.equal(scripts.length, 4);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const script of scripts) new AsyncFunction("require", script);
  const root = mkdtempSync(path.join(tmpdir(), "sdk-action-runtime-"));
  try {
    for (const phase of ["validate", "verify"]) {
      const script = scripts.find((source) => source.includes(`action.main("${phase}")`));
      assert.ok(script);
      const entry = path.join(root, `${phase}.cjs`), output = path.join(root, `${phase}.out`);
      writeFileSync(entry, `(async () => {\n${script}\n})().catch(() => {process.exitCode = 1});\n`);
      const result = spawnSync(process.execPath, [entry], {encoding: "utf8", env: {...process.env, PATH: "", Path: "",
        SDK_ACTION_PATH: fileURLToPath(new URL("../actions/hosted-sdk", import.meta.url)),
        SDK_RUNNER_ENVIRONMENT: "self-hosted", SDK_MANAGED: "true", SDK_NODE_VERSION: "", SDK_PYTHON_VERSION: "",
        SDK_BUN_VERSION: "", SDK_UV_VERSION: "", SDK_RUST_VERSION: "", SDK_JAVA_VERSION: "", SDK_GO_VERSION: "",
        SDK_FLUTTER_VERSION: "", SDK_TOOLS: "", SDK_RUST_COMPONENTS: "", SDK_RUST_TARGETS: "",
        GITHUB_OUTPUT: output, GITHUB_ENV: path.join(root, "environment")}});
      assert.equal(result.status, 0, result.stderr);
      const text = readFileSync(output, "utf8");
      if (phase === "validate") assert.match(text, /^bootstrap=false$/m);
      else assert.deepEqual(JSON.parse(text.trim().slice("receipt=".length)).versions, {});
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});
