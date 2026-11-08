import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

test("retained bootstrap tools must match their pinned bytes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-check-tools-"));
  const tools = path.join(root, "tools with spaces");
  writeFileSync(
    path.join(root, "justfile"),
    readFileSync(new URL("../justfile", import.meta.url)),
  );
  const run = (args, offline = false, environment = {}) =>
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
        ...environment,
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
  const digest = (binary) =>
    createHash("sha256").update(readFileSync(binary)).digest("hex");
  const refused = (args, offline = false) => {
    const result = run(args, offline);
    assert.notEqual(result.status, 0, "changed or missing pins must be refused");
    assert.equal(result.error, undefined, result.error?.message);
  };
  const noScratch = () =>
    assert.ok(
      readdirSync(path.join(tools, "checks")).every(
        (name) => !name.startsWith(".prepare."),
      ),
      "setup removes only its abandoned or finished preparation directories",
    );
  try {
    refused(["_tools", "check"], true);
    assert.equal(existsSync(tools), false, "offline validation creates nothing");
    accepted(["tools"]);
    const binary = find(tools, "actionlint");
    assert.ok(binary, "setup publishes the real pinned actionlint");
    const original = digest(binary);
    appendFileSync(binary, "retained-bootstrap-content-drift");
    const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
    assert.equal(version.status, 0, "the changed ELF still reports its version");
    refused(["_tools", "check"], true);
    const unavailable = run(["tools"], false, {
      NDS_CACHE_BASE: "http://127.0.0.1:0",
      NO_PROXY: "127.0.0.1",
      no_proxy: "127.0.0.1",
    });
    assert.notEqual(unavailable.status, 0, "an unavailable configured registry cannot be bypassed");
    assert.equal(unavailable.error, undefined, unavailable.error?.message);
    assert.notEqual(digest(binary), original, "a failed configured route cannot replace existing content");
    noScratch();
    accepted(["tools"]);
    assert.equal(digest(binary), original);
    accepted(["_tools", "check"], true);
    accepted(["tools"], true);

    // A changed committed digest must not silently reuse an already runnable version.
    const badPin = ["--set", "actionlint_sha256", "0".repeat(64)];
    refused([...badPin, "_tools", "check"], true);
    refused([...badPin, "tools"]);
    assert.equal(digest(binary), original, "failed replacement keeps accepted bytes");
    accepted(["_tools", "check"], true);
    noScratch();

    const receipt = path.join(path.dirname(binary), "sha256");
    const validReceipt = readFileSync(receipt);
    writeFileSync(receipt, "");
    refused(["_tools", "check"], true);
    writeFileSync(receipt, validReceipt);
    accepted(["_tools", "check"], true);

    // A real prior wheel is valid for its pin but cannot satisfy the current declaration.
    const previousWheel = "58e878eb2dbd2c6183c105e1ac28c14f7dd1eca44a783f1fe2a69647d012c410";
    accepted([
      "--set", "zizmor_version", "1.31.1",
      "--set", "zizmor_sha256", previousWheel,
      "tools",
    ]);
    const oldFolder = path.join(tools, "checks", `zizmor-${previousWheel}`);
    assert.equal(existsSync(oldFolder), true);
    refused(["_tools", "check"], true);

    const abandoned = path.join(tools, "checks", ".prepare.abandoned");
    mkdirSync(abandoned);
    writeFileSync(path.join(abandoned, "partial-archive"), "unfinished");
    writeFileSync(path.join(tools, "actionlint"), "obsolete flat tool");
    mkdirSync(path.join(tools, "zizmor"));
    writeFileSync(path.join(tools, "zizmor", "old-venv"), "obsolete environment");
    writeFileSync(path.join(tools, "unrelated"), "preserve");
    accepted(["tools"]);
    accepted(["_tools", "check"], true);
    assert.equal(existsSync(oldFolder), false);
    assert.equal(existsSync(path.join(tools, "actionlint")), false);
    assert.equal(existsSync(path.join(tools, "zizmor")), false);
    assert.equal(readFileSync(path.join(tools, "unrelated"), "utf8"), "preserve");
    noScratch();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
