import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { main as runAction } from "../actions/artifact-traces/run.mjs";
import {
  DEFAULT_POLICY_PATH,
  inspectDirectory,
  inspectOciArchive,
  inspectTarArchive,
  loadPolicy,
  matchPath,
  matchText,
} from "../lib/artifact-traces.mjs";
import { attribution } from "../lib/authorship.mjs";

function makeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = entry.content ? Buffer.from(entry.content) : Buffer.alloc(0);
    const header = Buffer.alloc(512);
    const nameBytes = Buffer.from(entry.name, "utf8");
    assert.ok(nameBytes.length <= 100, "fixture tar name fits in header");
    nameBytes.copy(header, 0);
    Buffer.from((entry.mode ?? (entry.directory ? 0o755 : 0o644)).toString(8).padStart(7, "0") + "\0").copy(header, 100);
    Buffer.from("0000000\0").copy(header, 108);
    Buffer.from("0000000\0").copy(header, 116);
    Buffer.from(data.length.toString(8).padStart(11, "0") + "\0").copy(header, 124);
    Buffer.from("00000000000\0").copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = entry.directory ? 0x35 : 0x30;
    Buffer.from("ustar\0").copy(header, 257);
    Buffer.from("00").copy(header, 263);
    let checksum = 0;
    for (let i = 0; i < 512; i += 1) checksum += header[i];
    Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);
    blocks.push(header);
    if (data.length > 0) {
      blocks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad > 0) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function makeOciArchive(destination, layers, { labels = {}, compression = "gzip" } = {}) {
  const blobs = new Map();
  const putBlob = (buffer) => {
    const digest = "sha256:" + createHash("sha256").update(buffer).digest("hex");
    blobs.set(digest, buffer);
    return { digest, size: buffer.length };
  };

  const layerDescriptors = [];
  const diffIds = [];
  for (const entries of layers) {
    const rawTar = makeTar(entries);
    diffIds.push("sha256:" + createHash("sha256").update(rawTar).digest("hex"));
    const compressed = compression === "zstd"
      ? zstdCompressSync(rawTar)
      : compression === "gzip"
        ? gzipSync(rawTar)
        : rawTar;
    const desc = putBlob(compressed);
    layerDescriptors.push({
      mediaType: compression === "zstd"
        ? "application/vnd.oci.image.layer.v1.tar+zstd"
        : "application/vnd.oci.image.layer.v1.tar+gzip",
      ...desc,
    });
  }

  const configDesc = putBlob(Buffer.from(JSON.stringify({
    architecture: "amd64",
    os: "linux",
    config: { Labels: labels },
    rootfs: { type: "layers", diff_ids: diffIds },
  })));

  const manifestDesc = putBlob(Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", ...configDesc },
    layers: layerDescriptors,
  })));

  const attestationDesc = putBlob(Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", ...configDesc },
    layers: [],
  })));

  const nestedIndexDesc = putBlob(Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { mediaType: "application/vnd.oci.image.manifest.v1+json", platform: { os: "linux", architecture: "amd64" }, ...manifestDesc },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": manifestDesc.digest },
        ...attestationDesc,
      },
    ],
  })));

  const archiveEntries = [
    { name: "oci-layout", content: JSON.stringify({ imageLayoutVersion: "1.0.0" }) },
    {
      name: "index.json",
      content: JSON.stringify({
        schemaVersion: 2,
        manifests: [{ mediaType: "application/vnd.oci.image.index.v1+json", ...nestedIndexDesc }],
      }),
    },
  ];
  for (const [digest, content] of blobs) {
    archiveEntries.push({ name: "blobs/sha256/" + digest.slice(7), content });
  }
  writeFileSync(destination, makeTar(archiveEntries));
}

test("shared policy is loaded and drives both authorship and artifact trace checks", () => {
  const policy = loadPolicy(DEFAULT_POLICY_PATH);
  assert.equal(policy.raw.schema_version, 1);
  assert.deepEqual(attribution("Generated with Claude Code"), [1]);
  assert.deepEqual(matchText("<!-- Generated with Claude Code -->", policy, { allowComments: true }), [1]);
  assert.deepEqual(matchText("// Co-authored-by: Codex <codex@openai.com>", policy, { allowComments: true }), [1]);
  assert.deepEqual(matchText("Co-authored-by: Claude Dupont <claude@example.org>", policy, { allowComments: true }), []);
  assert.deepEqual(matchText("// Update Codex and Claude Code through dependency automation.", policy, { allowComments: true }), []);
});

test("path rules reject forbidden filenames, directories, suffixes and harness binaries without false positives", () => {
  for (const [candidate, opts, expected] of [
    ["AGENTS.md", {}, "forbidden_filename"],
    ["nested/CLAUDE.md", {}, "forbidden_filename"],
    ["app/.cursorrules", {}, "forbidden_filename"],
    ["app/.aider.chat.history.md", {}, "forbidden_filename_prefix"],
    [".claude/settings.json", {}, "forbidden_directory"],
    ["root/.agents/skills/demo/SKILL.md", {}, "forbidden_directory"],
    ["etc/claude-code/managed-settings.json", {}, "forbidden_directory"],
    [".github/copilot-instructions.md", {}, "forbidden_path"],
    [".github/prompts/review.md", {}, "forbidden_path"],
    ["usr/local/bin/claude", { isExecutable: true }, "forbidden_binary"],
    ["bin/codex", {}, "forbidden_binary"],
    ["opt/tool/cursor-agent", { isExecutable: true }, "forbidden_binary"],
  ]) {
    const hit = matchPath(candidate, opts);
    assert.equal(hit?.kind, expected, candidate);
  }
  for (const [candidate, opts] of [
    ["app/src/cursor.js", {}],
    ["app/src/aider_client.py", {}],
    ["usr/share/icons/Adwaita/cursors/arrow", {}],
    ["srv/web/index.html", {}],
    ["app/.wh.AGENTS.md", {}],
  ]) {
    assert.equal(matchPath(candidate, opts), null, candidate);
  }
});

test("directory inspection passes clean trees and fails on every trace kind", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "artifact-traces-dir-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const clean = path.join(root, "clean");
  mkdirSync(path.join(clean, "srv/web"), { recursive: true });
  writeFileSync(path.join(clean, "srv/web/index.html"), "<!doctype html><title>Example</title>\n");
  writeFileSync(path.join(clean, "srv/web/binary.bin"), Buffer.from([0x00, 0x01, 0x02, ...Buffer.from("Generated with Claude Code")]));
  assert.deepEqual(inspectDirectory(clean), []);

  const withAgentFile = path.join(root, "agent-file");
  mkdirSync(withAgentFile);
  writeFileSync(path.join(withAgentFile, "AGENTS.md"), "# instructions\n");
  assert.equal(inspectDirectory(withAgentFile)[0].kind, "forbidden_filename");

  const withDir = path.join(root, "agent-dir");
  mkdirSync(path.join(withDir, ".serena"), { recursive: true });
  writeFileSync(path.join(withDir, ".serena/project.yml"), "name: demo\n");
  assert.equal(inspectDirectory(withDir)[0].kind, "forbidden_directory");

  const withBinary = path.join(root, "agent-bin");
  mkdirSync(path.join(withBinary, "usr/local/bin"), { recursive: true });
  const bin = path.join(withBinary, "usr/local/bin/claude");
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  assert.equal(inspectDirectory(withBinary)[0].kind, "forbidden_binary");

  const withSignature = path.join(root, "agent-sig");
  mkdirSync(withSignature);
  writeFileSync(path.join(withSignature, "app.js"), "// Generated with Claude Code\nexport const ok = true;\n");
  assert.equal(inspectDirectory(withSignature)[0].kind, "generated_signature");
});

test("tar and OCI image archives pass when clean and fail on gzip or zstd contaminated layers", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "artifact-traces-oci-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const cleanTar = path.join(root, "clean.tar.gz");
  writeFileSync(cleanTar, gzipSync(makeTar([
    { name: "app/server.js", content: "console.log('ok');\n" },
  ])));
  assert.deepEqual(await inspectTarArchive(cleanTar), []);

  const dirtyTar = path.join(root, "dirty.tar.zst");
  writeFileSync(dirtyTar, zstdCompressSync(makeTar([
    { name: "app/CLAUDE.md", content: "@AGENTS.md\n" },
  ])));
  assert.equal((await inspectTarArchive(dirtyTar))[0].kind, "forbidden_filename");

  const cleanOci = path.join(root, "clean.oci.tar");
  makeOciArchive(cleanOci, [[{ name: "image-fixture.txt", content: "fixture\n" }]], { compression: "zstd" });
  assert.deepEqual(await inspectOciArchive(cleanOci), []);

  // A trace added in a lower layer and deleted by a whiteout in an upper layer still fails.
  const layeredOci = path.join(root, "layered-dirty.oci.tar");
  makeOciArchive(layeredOci, [
    [{ name: "app/AGENTS.md", content: "# agent instructions\n" }],
    [{ name: "app/.wh.AGENTS.md", content: "" }],
  ], { compression: "gzip" });
  const layeredFindings = await inspectOciArchive(layeredOci);
  assert.equal(layeredFindings.length, 1);
  assert.equal(layeredFindings[0].kind, "forbidden_filename");

  const labelOci = path.join(root, "label-dirty.oci.tar");
  makeOciArchive(labelOci, [[{ name: "app/ok.txt", content: "ok\n" }]], {
    labels: { "org.opencontainers.image.description": "Generated by Codex" },
    compression: "zstd",
  });
  const labelFindings = await inspectOciArchive(labelOci);
  assert.equal(labelFindings.length, 1);
  assert.equal(labelFindings[0].kind, "generated_signature");
});

test("action entrypoint passes clean artifacts and rejects contaminated ones", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "artifact-traces-action-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const clean = path.join(root, "clean");
  mkdirSync(clean);
  writeFileSync(path.join(clean, "index.html"), "<p>ok</p>\n");
  await runAction({ GITHUB_WORKSPACE: root, INPUT_DIRECTORY: "clean" });

  const dirty = path.join(root, "dirty");
  mkdirSync(dirty);
  writeFileSync(path.join(dirty, "CLAUDE.md"), "@AGENTS.md\n");
  await assert.rejects(
    runAction({ GITHUB_WORKSPACE: root, INPUT_DIRECTORY: "dirty" }),
    /AI-coding trace/,
  );
  await assert.rejects(
    runAction({ GITHUB_WORKSPACE: root }),
    /exactly one/,
  );
});
