import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runProjectCommand } from "../lib/project-command.mjs";

test("runProjectCommand isolates child stdin as closed EOF and preserves stdout, stderr and exit codes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "project-command-"));
  try {
    const output = path.join(root, "github-output");
    const probeScript = [
      "const fs = require('node:fs');",
      "const data = fs.readFileSync(0);",
      "process.stdout.write('stdin-bytes=' + data.length + '\\n');",
      "process.stderr.write('stderr-ok\\n');",
    ].join(" ");
    const code = await runProjectCommand(process.execPath, ["-e", probeScript], {
      cwd: root,
      environment: { ...process.env, RUNNER_ENVIRONMENT: "github-hosted" },
      output,
    });
    assert.equal(code, 0);

    const failCode = await runProjectCommand(
      process.execPath,
      ["-e", "process.stderr.write('GitHub read returned HTTP 503\\n'); process.exit(23);"],
      {
        cwd: root,
        environment: { ...process.env, RUNNER_ENVIRONMENT: "self-hosted" },
        output,
      },
    );
    assert.equal(failCode, 23);
    assert.equal(readFileSync(output, "utf8"), "upstream-reason=github-5xx\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
