import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const lines = readFileSync(
  new URL("../actions/telemetry/switches.env", import.meta.url),
  "utf8",
)
  .split(/\r?\n/)
  .filter(Boolean);

test("telemetry switches are plain, unique, sorted assignments", () => {
  const names = lines.map((line) => {
    assert.match(line, /^[A-Z][A-Z0-9_]*=[A-Za-z0-9._-]+$/);
    return line.split("=")[0];
  });
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names, [...names].sort());
});

test("the switches cover the tools the library itself runs", () => {
  const values = Object.fromEntries(lines.map((line) => line.split("=")));
  for (const [name, value] of Object.entries({
    DO_NOT_TRACK: "1",
    BUN_DO_NOT_TRACK: "1",
    POUTINE_DISABLE_VERSION_CHECK: "true",
    TRIVY_DISABLE_TELEMETRY: "true",
    TRIVY_SKIP_VERSION_CHECK: "true",
    GRYPE_CHECK_FOR_APP_UPDATE: "false",
    SYFT_CHECK_FOR_APP_UPDATE: "false",
  }))
    assert.equal(values[name], value, name);
});
