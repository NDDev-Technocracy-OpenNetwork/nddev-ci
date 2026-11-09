// Vulnerable packages are inert scanner fixtures, never installed or executed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareScanner } from "../lib/dependency-scan.mjs";

test("daily reports retain vulnerable and disallowed-licence packages despite local overrides", {
  timeout: 600000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "daily-osv-native-"));
  try {
    const workspace = path.join(root, "checkout with spaces");
    const temporary = path.join(root, "runner temporary");
    const tools = path.join(root, "tools");
    for (const folder of [workspace, temporary, tools]) mkdirSync(folder);
    const binary = await prepareScanner(tools);
    writeFileSync(path.join(workspace, ".gitignore"), "nested/\n");
    for (const sub of ["", "nested"]) {
      const folder = path.join(workspace, sub);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        path.join(folder, "package-lock.json"),
        JSON.stringify({
          name: "inert-daily-data",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "inert-daily-data",
              version: "1.0.0",
              dependencies: { vm2: "3.9.10" },
            },
            "node_modules/vm2": {
              name: "vm2",
              version: "3.9.10",
              resolved: "https://registry.npmjs.org/vm2/-/vm2-3.9.10.tgz",
            },
          },
        }),
      );
      writeFileSync(
        path.join(folder, "osv-scanner.toml"),
        '[[PackageOverrides]]\nname="vm2"\necosystem="npm"\nignore=true\n',
      );
      writeFileSync(
        path.join(folder, "package.json"),
        JSON.stringify({ scripts: { install: "touch MUST_NOT_EXECUTE" } }),
      );
    }
    const run = (output) =>
      spawnSync(
        process.execPath,
        [new URL("../actions/daily-osv/run.mjs", import.meta.url).pathname],
        {
          cwd: workspace,
          encoding: "utf8",
          timeout: 600000,
          env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            RUNNER_TEMP: temporary,
            INPUT_SCANNER: binary,
            INPUT_OUTPUT: output,
            INPUT_LICENSES: "Apache-2.0",
          },
          maxBuffer: 64 * 1024 * 1024,
        },
      );
    const output = path.join(root, "reports");
    const result = run(output);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(path.join(output, "osv.json")));
    const affected = report.results.filter((r) =>
      r.packages?.some(
        (p) => p.package?.name === "vm2" && p.vulnerabilities?.length,
      ),
    );
    assert.equal(
      affected.length,
      2,
      "root and nested vm2 vulnerabilities must remain in the daily report",
    );
    const licenses = JSON.parse(
      readFileSync(path.join(output, "licenses.json")),
    );
    const disallowed = licenses.results.filter((r) =>
      r.packages?.some(
        (p) =>
          p.package?.name === "vm2" && p.license_violations?.includes("MIT"),
      ),
    );
    assert.equal(
      disallowed.length,
      2,
      "project overrides must not suppress known MIT licence findings",
    );
    for (const sub of ["", "nested"])
      assert.equal(
        existsSync(path.join(workspace, sub, "MUST_NOT_EXECUTE")),
        false,
      );
    assert.deepEqual(
      readdirSync(temporary),
      [],
      "the action removes its private scanner policy",
    );
    mkdirSync(path.join(workspace, "malformed"));
    writeFileSync(
      path.join(workspace, "malformed", "package-lock.json"),
      "{broken",
    );
    const failedOutput = path.join(root, "failed reports");
    const malformed = run(failedOutput);
    assert.ifError(malformed.error);
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /could not complete/);
    assert.equal(
      existsSync(failedOutput),
      false,
      "a failed scan publishes no clean report",
    );
    assert.deepEqual(readdirSync(temporary), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
