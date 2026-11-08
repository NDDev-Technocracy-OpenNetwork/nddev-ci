import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("retained bootstrap tools must match their pinned bytes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-check-tools-"));
  const tools = path.join(root, "tools");
  writeFileSync(
    path.join(root, "justfile"),
    readFileSync(new URL("../justfile", import.meta.url)),
  );
  const run = (args, offline = false) =>
    spawnSync("just", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 180000,
      env: {
        ...process.env,
        NDDEV_CI_CHECK_TOOLS: tools,
        ...(offline
          ? {
              HTTP_PROXY: "http://127.0.0.1:9",
              HTTPS_PROXY: "http://127.0.0.1:9",
              http_proxy: "http://127.0.0.1:9",
              https_proxy: "http://127.0.0.1:9",
              NO_PROXY: "",
              no_proxy: "",
            }
          : {}),
      },
    });
  const accepted = (args, offline = false) => {
    const result = run(args, offline);
    assert.equal(result.status, 0, result.stderr);
  };
  const find = (folder, name) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const candidate = path.join(folder, entry.name);
      if (entry.isFile() && entry.name === name) return candidate;
      if (entry.isDirectory()) {
        const nested = find(candidate, name);
        if (nested) return nested;
      }
    }
  };
  try {
    accepted(["tools"]);
    const binary = find(tools, "actionlint");
    assert.ok(binary, "setup publishes the real pinned actionlint");
    const original = readFileSync(binary);
    appendFileSync(binary, "retained-bootstrap-content-drift");
    const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
    assert.equal(version.status, 0, "the changed ELF still reports its version");
    accepted(["tools"]);
    assert.deepEqual(readFileSync(binary), original);
    accepted(["tools"], true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
