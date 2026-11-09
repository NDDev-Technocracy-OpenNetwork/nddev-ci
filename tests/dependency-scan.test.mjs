import assert from "node:assert/strict";
import test from "node:test";

import { scannerPin, scannerPins } from "../lib/dependency-scan.mjs";

test("each supported native Linux architecture selects its own pinned scanner", () => {
  assert.equal(scannerPin("linux", "x64"), scannerPins.x64);
  assert.equal(scannerPin("linux", "x64").name, "osv-scanner_linux_amd64");
  assert.equal(scannerPin("linux", "arm64"), scannerPins.arm64);
  assert.equal(scannerPin("linux", "arm64").name, "osv-scanner_linux_arm64");
  for (const pin of Object.values(scannerPins)) {
    assert.equal(pin.version, "2.7.0");
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(pin.asset) && pin.asset > 0);
    assert.ok(Number.isSafeInteger(pin.size) && pin.size > 0);
  }
  assert.notEqual(scannerPins.x64.sha256, scannerPins.arm64.sha256);
});

test("unsupported platforms and architectures refuse before any download", () => {
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["win32", "x64"],
    ["linux", "ia32"],
    ["linux", "__proto__"],
    ["linux", "toString"],
  ])
    assert.throws(
      () => scannerPin(platform, arch),
      /requires a native Linux x64 or ARM64 runner/,
    );
});
