import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { databases, main } from "../actions/daily-sbom/run.mjs";

// A stand-in for each scanner: it records the database addresses it was given, and writes the
// report its caller expects.
const stub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
fs.appendFileSync(
  path.join(path.dirname(process.argv[1]), "calls.log"),
  JSON.stringify({
    tool,
    grype: process.env.GRYPE_DB_UPDATE_URL ?? null,
    trivy: process.env.TRIVY_DB_REPOSITORY ?? null,
    java: process.env.TRIVY_JAVA_DB_REPOSITORY ?? null,
  }) + "\\n",
);
if (tool === "syft") {
  const out = args.find((arg) => arg.startsWith("cyclonedx-json=")).slice(15);
  fs.writeFileSync(out, "{}");
}
if (tool === "grype") process.stdout.write(JSON.stringify({ matches: [] }));
if (tool === "trivy") fs.writeFileSync(args[args.indexOf("--output") + 1], "{}");
`;

function job() {
  const root = mkdtempSync(path.join(tmpdir(), "daily-sbom-"));
  const workspace = path.join(root, "checkout");
  const temporary = path.join(root, "temporary");
  const tools = path.join(root, "tools");
  for (const folder of [workspace, temporary, tools]) mkdirSync(folder);
  for (const tool of ["syft", "grype", "trivy"]) {
    writeFileSync(path.join(tools, tool), stub);
    chmodSync(path.join(tools, tool), 0o700);
  }
  const environment = {
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: temporary,
    INPUT_TOOLS: tools,
    INPUT_OUTPUT: path.join(root, "reports"),
  };
  delete environment.NDDEV_CI_ARTIFACT_REGISTRY;
  for (const name of ["GRYPE_DB_UPDATE_URL", "TRIVY_DB_REPOSITORY", "TRIVY_JAVA_DB_REPOSITORY"])
    delete environment[name];
  const calls = () =>
    readFileSync(path.join(tools, "calls.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { root, environment, calls };
}

const linux = {
  skip: process.platform === "linux" ? false : "the daily scan is Linux-only",
};

test("a declared registry gives Grype and Trivy their databases", linux, (t) => {
  const { root, environment, calls } = job();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  environment.NDDEV_CI_ARTIFACT_REGISTRY = "http://127.0.0.1:8740/";
  main(environment, "2026-11-11");
  assert.deepEqual(
    calls().map((call) => call.tool),
    ["syft", "grype", "trivy"],
  );
  for (const call of calls()) {
    assert.equal(call.grype, "http://127.0.0.1:8740/grype/2026-11-11");
    assert.equal(call.trivy, "127.0.0.1:8740/ghcr.io/aquasecurity/trivy-db:2");
    assert.equal(call.java, "127.0.0.1:8740/ghcr.io/aquasecurity/trivy-java-db:1");
  }
});

test("without a declared registry each scanner keeps its own source", linux, (t) => {
  const { root, environment, calls } = job();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  main(environment, "2026-11-11");
  for (const call of calls())
    assert.deepEqual([call.grype, call.trivy, call.java], [null, null, null]);
  assert.deepEqual(databases(environment, "2026-11-11"), {});
  assert.throws(
    () =>
      databases(
        { NDDEV_CI_ARTIFACT_REGISTRY: "http://user@127.0.0.1:8740" },
        "2026-11-11",
      ),
    /Invalid declared security tool registry/,
  );
});
