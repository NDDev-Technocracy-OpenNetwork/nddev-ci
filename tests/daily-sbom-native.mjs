// The package lock is inert scanner input. No dependency is installed or run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { downloadAsset } from "../lib/release-asset.mjs";

async function tools(directory) {
  // Tool versions and archive hashes come from the same declaration as the daily workflow.
  const workflow = readFileSync(
    new URL("../.github/workflows/security.yml", import.meta.url),
    "utf8",
  );
  const value = (name) => {
    const match = workflow.match(new RegExp(`^      ${name}: "([^"]+)"$`, "m"));
    assert(match, `the workflow declares ${name}`);
    return match[1];
  };
  const assets = [
    [
      "syft",
      "anchore/syft",
      727815727,
      31432061,
      `syft_${value("SYFT_VERSION")}_linux_amd64.tar.gz`,
    ],
    [
      "grype",
      "anchore/grype",
      727934779,
      32643999,
      `grype_${value("GRYPE_VERSION")}_linux_amd64.tar.gz`,
    ],
    [
      "trivy",
      "aquasecurity/trivy",
      713401165,
      52714130,
      `trivy_${value("TRIVY_VERSION")}_Linux-64bit.tar.gz`,
    ],
  ];
  for (const [tool, repository, asset, size, name] of assets) {
    // These asset IDs are the Linux x64 archives that the library's own check runs on.
    const sha256 = value(`${tool.toUpperCase()}_SHA256_X64`);
    const archive = path.join(directory, `${tool}.tar.gz`);
    // The same verified transport serves upstream and an explicitly declared registry.
    await downloadAsset(
      { repository, asset, size, sha256, name, tag: `v${value(`${tool.toUpperCase()}_VERSION`)}` },
      archive,
      tool === "trivy" ? undefined : process.env.GH_TOKEN,
      process.env.NDDEV_CI_ARTIFACT_REGISTRY,
    );
    const bytes = readFileSync(archive);
    assert.equal(bytes.length, size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
    const unpacked = spawnSync("tar", ["-xOzf", archive, "--", tool], {
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120000,
    });
    assert.ifError(unpacked.error);
    assert.equal(
      unpacked.status,
      0,
      `extract the exact accepted ${tool} archive member`,
    );
    const executable = path.join(directory, tool);
    writeFileSync(executable, unpacked.stdout, { mode: 0o700 });
    chmodSync(executable, 0o700);
    rmSync(archive);
  }
}

test("daily SBOM and vulnerability reports ignore local scanner suppressions", {
  timeout: 600000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "daily-sbom-native-"));
  try {
    const workspace = path.join(root, "checkout");
    const temporary = path.join(root, "runner temporary");
    const prepared = path.join(root, "tools");
    const output = path.join(root, "reports");
    for (const folder of [workspace, temporary, prepared]) mkdirSync(folder);
    await tools(prepared);
    writeFileSync(
      path.join(workspace, "package-lock.json"),
      JSON.stringify({
        name: "inert-sbom-data",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "inert-sbom-data",
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
      path.join(workspace, ".syft.yaml"),
      'exclude: ["**/package-lock.json"]\n',
    );
    writeFileSync(
      path.join(workspace, ".grype.yaml"),
      "ignore:\n  - package:\n      name: vm2\n",
    );
    writeFileSync(
      path.join(workspace, "trivy.yaml"),
      'severity: ["UNKNOWN"]\n',
    );
    writeFileSync(
      path.join(workspace, "package.json"),
      JSON.stringify({ scripts: { install: "touch MUST_NOT_EXECUTE" } }),
    );
    const run = (extra = {}) =>
      spawnSync(
        process.execPath,
        [new URL("../actions/daily-sbom/run.mjs", import.meta.url).pathname],
        {
          cwd: workspace,
          encoding: "utf8",
          timeout: 600000,
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            RUNNER_TEMP: temporary,
            INPUT_TOOLS: prepared,
            INPUT_OUTPUT: output,
            SYFT_CHECK_FOR_APP_UPDATE: "false",
            GRYPE_CHECK_FOR_APP_UPDATE: "false",
            TRIVY_SKIP_VERSION_CHECK: "true",
            TRIVY_DISABLE_TELEMETRY: "true",
            DO_NOT_TRACK: "1",
            ...extra,
          },
        },
      );
    const result = run();
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const missing = run({ INPUT_SBOMS: path.join(root, "missing caller") });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Caller SBOMs require/);
    assert.doesNotMatch(missing.stdout, /Running syft/);
    const emptyCaller = path.join(root, "empty caller");
    mkdirSync(emptyCaller);
    const empty = run({ INPUT_SBOMS: emptyCaller });
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /no JSON inventories/);
    assert.doesNotMatch(empty.stdout, /Running syft/);
    const parse = (name) => JSON.parse(readFileSync(path.join(output, name)));
    const inventory = parse("sbom-repository.json");
    assert(
      (inventory.components ?? []).some(
        (p) => p.name === "vm2" && p.version === "3.9.10",
      ),
      "Syft must inventory vm2 despite local path exclusion",
    );
    const grype = parse("grype-sbom-repository.json");
    assert(
      grype.matches.some((m) => m.artifact.name === "vm2"),
      "Grype must report vm2 despite the local package ignore rule",
    );
    const trivy = parse("trivy-sbom-repository.json");
    const found = (trivy.Results ?? []).flatMap((r) => r.Vulnerabilities ?? []);
    assert(
      found.some((v) => v.PkgName === "vm2" && v.Severity === "CRITICAL"),
      "Trivy must retain critical findings despite local severity filtering",
    );
    // A caller may have generated its SBOM under another source/credential context.
    const caller = path.join(root, "caller");
    mkdirSync(caller);
    writeFileSync(path.join(caller, "product.json"), JSON.stringify(inventory));
    writeFileSync(
      path.join(caller, "product.name"),
      "qualified-image@sha256:fixture\n",
    );
    writeFileSync(
      path.join(workspace, ".trivyignore"),
      found.map((v) => v.VulnerabilityID).join("\n") + "\n",
    );
    const supplied = run({ INPUT_SBOMS: caller });
    assert.equal(supplied.status, 0, supplied.stderr);
    assert(
      parse("grype-sbom-caller-product.json").matches.some(
        (m) => m.artifact.name === "vm2",
      ),
    );
    const callerTrivy = parse("trivy-sbom-caller-product.json");
    assert(
      (callerTrivy.Results ?? []).some((r) =>
        r.Vulnerabilities?.some((v) => v.PkgName === "vm2"),
      ),
      "a local .trivyignore must not suppress caller SBOM findings",
    );
    assert.equal(
      readFileSync(path.join(output, "sbom-caller-product.name"), "utf8"),
      "qualified-image@sha256:fixture\n",
    );
    writeFileSync(path.join(caller, "malformed.json"), "{broken");
    const malformed = run({ INPUT_SBOMS: caller });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /could not complete/);
    assert.equal(existsSync(path.join(workspace, "MUST_NOT_EXECUTE")), false);
    assert.deepEqual(
      readdirSync(temporary),
      [],
      "owned scanner policy is removed on success and failure",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
