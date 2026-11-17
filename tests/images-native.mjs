import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {admit, cleanup, initialize, inspectArchive, produce} from "../lib/images.mjs";

const module = fileURLToPath(new URL("../lib/images.mjs", import.meta.url));
const call = (args, options = {}) => {
  const result = spawnSync(args[0], args.slice(1), {encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 600000, ...options});
  assert.equal(result.status, 0, result.stderr ?? result.error?.message);
  return result.stdout.trim();
};
const present = (reference) => spawnSync("docker", ["image", "inspect", reference], {stdio: "ignore"}).status === 0;
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
function fixture() {
  assert.ok(process.env.BUILDX_BUILDER, "Prepare the native BuildKit provider first.");
  assert.match(call(["docker", "info", "--format", "{{json .DriverStatus}}"]), /io.containerd.snapshotter.v1/);
  const root = mkdtempSync(path.join(process.env.RUNNER_TEMP ?? process.cwd(), "images-native-"));
  const workspace = path.join(root, "source"), temporary = path.join(root, "temporary");
  mkdirSync(workspace); mkdirSync(temporary);
  writeFileSync(path.join(workspace, "Dockerfile"), "FROM scratch\nARG PUBLIC_LABEL\nCOPY marker /marker\n");
  writeFileSync(path.join(workspace, "marker"), "canonical image fixture\n");
  writeFileSync(path.join(workspace, "Broken"), "FROM scratch\nCOPY absent-file /absent-file\n");
  call(["git", "init", "-q"], {cwd: workspace});
  call(["git", "add", "."], {cwd: workspace});
  call(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "test: qualify image artifacts"], {cwd: workspace});
  const source = call(["git", "rev-parse", "HEAD"], {cwd: workspace});
  const env = {...process.env, GITHUB_REPOSITORY: "example/image-fixture", GITHUB_SHA: source,
    GITHUB_RUN_ID: "258", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "image",
    GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temporary};
  for (const line of initialize(env).trim().split("\n")) {
    const equal = line.indexOf("="); env[line.slice(0, equal)] = line.slice(equal + 1);
  }
  const image = {name: "application", dockerfile: "Dockerfile", context: ".", platform: "linux/amd64",
    public_build_args: {PUBLIC_LABEL: "$(touch never-created); literal public argument"}};
  return {root, workspace, env, image, plan: {schema: 1, output: "dist/images", images: [image]}};
}

test("real canonical batch, replay, refusal, scans and exact resource cleanup", {timeout: 600000}, async (t) => {
  const f = fixture(), output = path.join(f.workspace, f.plan.output);
  f.plan.images.push({...f.image, name: "worker"});
  let reference, foreign, foreignContainer;
  try {
    const receipt = await produce(f.plan, f.env), row = receipt.images[0];
    assert.equal(receipt.images.length, 2);
    assert.notEqual(receipt.images[0].build_input_digest, receipt.images[1].build_input_digest);
    reference = row.reference;
    assert.notEqual(row.image_id, row.oci_index_digest);
    const loaded = JSON.parse(call(["docker", "image", "inspect", reference]))[0];
    assert.equal(loaded.Id, row.oci_index_digest);
    assert.equal(loaded.Descriptor.digest, row.oci_index_digest);
    assert.ok(!existsSync(path.join(f.workspace, "never-created")));

    await t.test("completed replay succeeds without any available builder and reuses exact files", async () => {
      const manifest = readFileSync(path.join(output, "images.json"));
      const mtime = statSync(path.join(output, row.archive)).mtimeMs;
      const builder = f.env.BUILDX_BUILDER;
      f.env.BUILDX_BUILDER = "no-rebuild-is-available";
      try {
        assert.deepEqual(await produce(f.plan, f.env), receipt);
        cleanup(f.env);
        assert.equal(present(reference), false);
        assert.deepEqual(await produce(f.plan, f.env), receipt);
      } finally { f.env.BUILDX_BUILDER = builder; }
      assert.deepEqual(readFileSync(path.join(output, "images.json")), manifest);
      assert.equal(statSync(path.join(output, row.archive)).mtimeMs, mtime);
    });

    await t.test("current Trivy, Syft and Grype inspect the exact loaded reference", () => {
      const sbom = path.join(f.root, "sbom.spdx.json");
      call(["trivy", "image", "--image-src", "docker", "--scanners", "vuln", "--severity", "HIGH,CRITICAL",
        "--exit-code", "1", "--format", "json", "--output", path.join(f.root, "trivy.json"), reference]);
      call(["syft", "docker:" + reference, "-o", "spdx-json=" + sbom]);
      call(["grype", "sbom:" + sbom, "--fail-on", "high", "--output", "json"]);
      assert.ok(JSON.parse(readFileSync(sbom, "utf8")).spdxVersion);
    });

    await t.test("cleanup removes owned containers/tags, preserving an unrelated alias and container", async () => {
      foreign = "nddev-ci-unrelated-control:" + f.env.NDDEV_CI_IMAGE_OWNER;
      call(["docker", "tag", reference, foreign]);
      foreignContainer = call(["docker", "create", foreign, "/marker"]);
      const ownedContainer = call(["docker", "create", "--label",
        "org.nddev.ci.container-owner=" + f.env.NDDEV_CI_IMAGE_OWNER, reference, "/marker"]);
      cleanup(f.env);
      assert.equal(present(reference), false);
      assert.equal(present(foreign), true);
      assert.equal(spawnSync("docker", ["container", "inspect", ownedContainer], {stdio: "ignore"}).status, 1);
      assert.equal(spawnSync("docker", ["container", "inspect", foreignContainer], {stdio: "ignore"}).status, 0);
      await produce(f.plan, f.env);
    });

    await t.test("changed public input, run or source cannot reuse completed output", async () => {
      const changed = structuredClone(f.plan); changed.images[0].public_build_args.PUBLIC_LABEL = "altered";
      await assert.rejects(produce(changed, f.env), /binding/);
      await assert.rejects(produce(f.plan, {...f.env, GITHUB_RUN_ATTEMPT: "2"}), /another job/);
      await assert.rejects(produce(f.plan, {...f.env, NDDEV_CI_IMAGE_BUILD_ARGV: '["--push"]'}), /provider/);
      writeFileSync(path.join(f.workspace, "marker"), "changed tracked source\n");
      await assert.rejects(produce(f.plan, f.env), /git/);
      call(["git", "restore", "--", "marker"], {cwd: f.workspace});
      await produce(f.plan, f.env);
    });

    await t.test("swapping images inside a complete batch fails per-image build binding", async () => {
      const first = path.join(output, receipt.images[0].archive), second = path.join(output, receipt.images[1].archive);
      const a = readFileSync(first), b = readFileSync(second);
      writeFileSync(first, b); writeFileSync(second, a);
      await assert.rejects(produce(f.plan, f.env), /binding/);
      writeFileSync(first, a); writeFileSync(second, b);
      await produce(f.plan, f.env);
    });

    await t.test("a real OCI export without provenance and SBOM is refused", async () => {
      const bare = path.join(f.root, "bare.oci.tar");
      call(["docker", "buildx", "build", "--platform", "linux/amd64", "--provenance=false", "--sbom=false",
        "--output", "type=oci,dest=" + bare, "--file", path.join(f.workspace, "Dockerfile"), f.workspace]);
      await assert.rejects(inspectArchive(bare, {...f.image, reference}, {}), /attestation/);
    });

    await t.test("repeated tar members and damaged additional transport refuse without fallback", async () => {
      const archive = path.join(output, row.archive), damaged = path.join(f.root, "repeated.tar");
      copyFileSync(archive, damaged);
      const duplicate = path.join(f.root, "duplicate"); mkdirSync(duplicate);
      writeFileSync(path.join(duplicate, "index.json"), "{}\n");
      call(["tar", "--append", "--file", damaged, "-C", duplicate, "index.json"]);
      await assert.rejects(inspectArchive(damaged, {...f.image, reference}, {}), /repeated/);
      const saved = path.join(output, row.load_archive), original = readFileSync(saved);
      truncateSync(saved, 1024);
      await assert.rejects(produce(f.plan, f.env));
      assert.equal(present(foreign), true);
      writeFileSync(saved, original);
      await produce(f.plan, f.env);
    });

    await t.test("altered receipt and unexpected output entries are never overwritten", async () => {
      const manifest = path.join(output, "images.json"), original = readFileSync(manifest);
      chmodSync(manifest, 0o600);
      await assert.rejects(produce(f.plan, f.env), /modes/);
      chmodSync(manifest, 0o644);
      const changed = JSON.parse(original); changed.images[0].image_id = "sha256:" + "f".repeat(64);
      json(manifest, changed);
      await assert.rejects(produce(f.plan, f.env), /binding/);
      assert.deepEqual(JSON.parse(readFileSync(manifest)), changed);
      writeFileSync(manifest, original);
      const extra = path.join(output, "foreign.txt"); writeFileSync(extra, "preserve");
      await assert.rejects(produce(f.plan, f.env), /foreign/);
      assert.equal(readFileSync(extra, "utf8"), "preserve");
      rmSync(extra);
    });
  } finally {
    cleanup(f.env);
    if (foreignContainer) call(["docker", "container", "rm", "--force", foreignContainer]);
    if (foreign && present(foreign)) call(["docker", "image", "rm", foreign]);
    rmSync(f.root, {recursive: true, force: true});
  }
});

test("a later build failure leaves no completed receipt and cleans earlier loaded images", {timeout: 600000}, async () => {
  const f = fixture();
  f.plan.images.push({...f.image, name: "broken", dockerfile: "Broken"});
  try {
    await assert.rejects(produce(f.plan, f.env), /build failed/);
    assert.equal(existsSync(path.join(f.workspace, f.plan.output, "images.json")), false);
    const owned = call(["docker", "image", "ls", "--filter", "label=org.nddev.ci.image-owner=" + f.env.NDDEV_CI_IMAGE_OWNER, "-q"]);
    assert.equal(owned, "");
    await assert.rejects(produce(f.plan, f.env), /partial/);
  } finally { cleanup(f.env); rmSync(f.root, {recursive: true, force: true}); }
});

test("cancellation cleans previously loaded job resources while preserving partial output refusal", {timeout: 600000}, async () => {
  const f = fixture();
  const large = path.join(f.workspace, "large"); writeFileSync(large, ""); truncateSync(large, 64 * 1024 * 1024);
  writeFileSync(path.join(f.workspace, "Slow"), "FROM scratch\nCOPY large /large\n");
  call(["git", "add", "large", "Slow"], {cwd: f.workspace});
  call(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "test: exercise build cancellation"], {cwd: f.workspace});
  f.env.GITHUB_SHA = call(["git", "rev-parse", "HEAD"], {cwd: f.workspace});
  // A new exact source gets its own prepared job state.
  rmSync(path.join(f.env.RUNNER_TEMP, "nddev-ci"), {recursive: true});
  for (const line of initialize(f.env).trim().split("\n")) {
    const equal = line.indexOf("="); f.env[line.slice(0, equal)] = line.slice(equal + 1);
  }
  f.plan.images.push({...f.image, name: "worker", dockerfile: "Slow"});
  const plan = path.join(f.root, "plan.json"); json(plan, f.plan);
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [module, "produce", plan], {cwd: f.workspace, env: f.env, stdio: ["ignore", "pipe", "pipe"]});
      let sent = false, logs = "";
      child.stdout.on("data", (chunk) => {
        logs += chunk;
        if (!sent && logs.includes("Canonical image build: worker")) { sent = true; child.kill("SIGTERM"); }
      });
      child.stderr.on("data", (chunk) => { logs += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({code, sent, logs}));
    });
    assert.equal(result.sent, true, result.logs);
    assert.equal(result.code, 143, result.logs);
    assert.equal(call(["docker", "image", "ls", "--filter", "label=org.nddev.ci.image-owner=" + f.env.NDDEV_CI_IMAGE_OWNER, "-q"]), "");
    assert.equal(existsSync(path.join(f.workspace, f.plan.output, "images.json")), false);
    await assert.rejects(produce(f.plan, f.env), /partial/);
  } finally { cleanup(f.env); rmSync(f.root, {recursive: true, force: true}); }
});

test("new input guards refuse changed tracked input or foreign receipt during a real build", {timeout: 600000}, async (t) => {
  for (const mode of ["source", "foreign-receipt"]) await t.test(mode, async () => {
    const f = fixture(), plan = path.join(f.root, "plan.json");
    json(plan, f.plan);
    let changed = false;
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [module, "produce", plan], {cwd: f.workspace, env: f.env, stdio: ["ignore", "pipe", "pipe"]});
        let logs = "";
        child.stdout.on("data", (chunk) => {
          logs += chunk;
          if (!changed && logs.includes("Canonical image build: application")) {
            changed = true;
            if (mode === "source") writeFileSync(path.join(f.workspace, "marker"), "changed during the build\\n");
            else writeFileSync(path.join(f.workspace, f.plan.output, "images.json"), "foreign receipt");
          }
        });
        child.stderr.on("data", (chunk) => { logs += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({code, logs}));
      });
      assert.ok(changed, result.logs);
      assert.equal(result.code, 1, result.logs);
      const manifest = path.join(f.workspace, f.plan.output, "images.json");
      if (mode === "foreign-receipt") assert.equal(readFileSync(manifest, "utf8"), "foreign receipt");
      else assert.equal(existsSync(manifest), false);
      assert.equal(call(["docker", "image", "ls", "--filter", "label=org.nddev.ci.image-owner=" + f.env.NDDEV_CI_IMAGE_OWNER, "-q"]), "");
    } finally { cleanup(f.env); rmSync(f.root, {recursive: true, force: true}); }
  });
});

test("declared Docker endpoint binds production, replay and cleanup without fallback", {timeout: 600000}, async () => {
  const f = fixture();
  try {
    const receipt = await produce(f.plan, f.env), reference = receipt.images[0].reference;
    const changed = {...f.env, DOCKER_HOST: "unix://" + path.join(f.root, "unrelated.sock")};
    await assert.rejects(produce(f.plan, changed), /Docker endpoint/);
    assert.throws(() => cleanup(changed), /Docker endpoint/);
    assert.equal(present(reference), true);
    f.env.BUILDX_BUILDER = "no-rebuild-is-available";
    assert.deepEqual(await produce(f.plan, f.env), receipt);
    cleanup(f.env);
    assert.equal(present(reference), false);
  } finally { cleanup(f.env); rmSync(f.root, {recursive: true, force: true}); }
});
