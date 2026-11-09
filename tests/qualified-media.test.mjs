// Isolated provider research only; this file is not part of the accepted library/product.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
const manifest = JSON.parse(readFileSync(new URL("./fixtures/media-candidate/assets.json", import.meta.url)));
for (const member of manifest.assets[0].members) {
  test(`the shared check provisions the exact ${member.file} executable on PATH`, () => {
    const location = spawnSync("which", [member.file], {encoding: "utf8"});
    assert.equal(location.status, 0, location.stderr);
    const binary = realpathSync(location.stdout.trim());
    assert.equal(binary, realpathSync(path.join(process.env.RUNNER_TEMP, "nddev-ci/native-tools", member.file)));
    assert.equal(createHash("sha256").update(readFileSync(binary)).digest("hex"), member.sha256);
    const result = spawnSync(member.file, ["-version"], {encoding: "utf8", timeout: 10000});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /n9\.0\.2-39-g7adfbe40dc-20261031/);
  });
}
