import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  readdirSync,
  realpathSync,
  appendFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadAsset } from "../lib/release-asset.mjs";
import { main } from "../actions/release-assets/run.mjs";

const bytes = Buffer.from("pinned tool fixture");
const asset = {
  repository: "example/tool",
  asset: 123,
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  file: "tool.bin",
  executable: true,
};

test("authenticates only the official API and verifies streamed bytes", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-asset-"));
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: String(url), options });
    return requests.length === 1
      ? new Response(null, {
          status: 302,
          headers: {
            location: "https://release-assets.githubusercontent.com/asset",
          },
        })
      : new Response(bytes);
  });
  try {
    const target = path.join(directory, "tool");
    await downloadAsset(asset, target, "test-read-token");
    assert.deepEqual(readFileSync(target), bytes);
    assert.equal(
      requests[0].options.headers.Authorization,
      "Bearer test-read-token",
    );
    assert.equal(requests[1].options.headers.Authorization, undefined);
    assert.equal(requests[1].options.redirect, "error");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const variant of ["redirect", "size", "digest", "forbidden"]) {
  test(`refuses ${variant} failures without retrying or changing source`, async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "release-refusal-"));
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests += 1;
      if (variant === "redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.net/tool" },
        });
      if (variant === "forbidden") return new Response(null, { status: 403 });
      return new Response(
        variant === "size"
          ? Buffer.concat([bytes, bytes])
          : Buffer.alloc(bytes.length),
      );
    });
    try {
      await assert.rejects(
        downloadAsset(asset, path.join(directory, "tool"), "test-read-token"),
      );
      assert.equal(requests, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("valid warm assets need no download and unsafe destinations create nothing", async (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), "release-workspace-"));
  const temporary = mkdtempSync(path.join(tmpdir(), "release-temporary-"));
  const outside = mkdtempSync(path.join(tmpdir(), "release-outside-"));
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("warm asset must not download");
  });
  try {
    writeFileSync(
      path.join(workspace, "assets.json"),
      JSON.stringify({ schema_version: 1, assets: [asset] }),
    );
    const directory = path.join(temporary, "tools");
    mkdirSync(directory);
    writeFileSync(path.join(directory, asset.file), bytes);
    const environment = {
      RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: temporary,
      INPUT_MANIFEST: "assets.json",
      INPUT_DIRECTORY: directory,
    };
    await main(environment);
    assert.deepEqual(readFileSync(path.join(directory, asset.file)), bytes);
    await assert.rejects(
      main({ ...environment, RUNNER_ENVIRONMENT: "self-hosted" }),
    );
    symlinkSync(
      outside,
      path.join(workspace, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      main({ ...environment, INPUT_DIRECTORY: "escape/uncreated" }),
    );
    assert.equal(existsSync(path.join(outside, "uncreated")), false);
    const linked = path.join(directory, asset.file);
    rmSync(linked);
    writeFileSync(path.join(outside, asset.file), bytes);
    symlinkSync(
      outside,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(main(environment));
  } finally {
    for (const directory of [workspace, temporary, outside])
      rmSync(directory, { recursive: true, force: true });
  }
});

test("prepares only pinned archive members and repairs changed warm bytes before publishing PATH", async (t) => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), "native-members-workspace-"),
  );
  const temporary = mkdtempSync(
    path.join(tmpdir(), "native-members-temporary-"),
  );
  try {
    const input = path.join(workspace, "input");
    mkdirSync(input);
    const contents = Buffer.from("exact native member bytes\n");
    writeFileSync(path.join(input, "native-tool"), contents);
    writeFileSync(
      path.join(input, "unselected"),
      "do not extract this sibling",
    );
    const archive = path.join(workspace, "source.tar");
    const packed = spawnSync(
      "tar",
      ["-cf", archive, "-C", input, "native-tool", "unselected"],
      { encoding: "utf8" },
    );
    assert.equal(packed.status, 0, packed.stderr);
    const bytes = readFileSync(archive);
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return new Response(bytes);
    });
    const member = {
      path: "native-tool",
      file: "prepared-tool",
      size: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex"),
      executable: true,
    };
    const asset = {
      repository: "example/tool",
      asset: 123,
      file: "source.tar",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      members: [member],
    };
    const manifest = path.join(workspace, "assets.json");
    const save = (value) =>
      writeFileSync(
        manifest,
        JSON.stringify({ schema_version: 1, assets: [value] }),
      );
    save(asset);
    const directory = path.join(temporary, "tools");
    const environment = {
      RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: temporary,
      INPUT_MANIFEST: "assets.json",
      INPUT_DIRECTORY: directory,
      "INPUT_ADD-TO-PATH": "true",
      GITHUB_PATH: path.join(temporary, "path"),
      GITHUB_OUTPUT: path.join(temporary, "output"),
    };
    await main(environment);
    assert.deepEqual(readFileSync(path.join(directory, member.file)), contents);
    assert.equal(existsSync(path.join(directory, "unselected")), false);
    assert.equal(
      readFileSync(environment.GITHUB_PATH, "utf8"),
      realpathSync(directory) + "\n",
    );
    const receipt = JSON.parse(
      readFileSync(environment.GITHUB_OUTPUT, "utf8")
        .split("\n")
        .find((line) => line.startsWith("receipt="))
        .slice(8),
    );
    assert.equal(receipt.assets[0].files[1].sha256, member.sha256);
    await main(environment);
    assert.equal(requests, 1, "warm archive and members require no transport");
    appendFileSync(path.join(directory, member.file), "changed");
    await main(environment);
    assert.equal(
      requests,
      1,
      "a verified warm archive repairs the changed member without another origin",
    );
    assert.deepEqual(readFileSync(path.join(directory, member.file)), contents);
    save({ ...asset, members: [{ ...member, sha256: "0".repeat(64) }] });
    writeFileSync(environment.GITHUB_PATH, "previous\n");
    await assert.rejects(main(environment));
    assert.deepEqual(
      readFileSync(path.join(directory, member.file)),
      contents,
      "a failed member verification preserves accepted bytes",
    );
    assert.equal(readFileSync(environment.GITHUB_PATH, "utf8"), "previous\n");
    assert.ok(
      readdirSync(directory).every((name) => !name.startsWith(".asset-")),
    );
    save({ ...asset, members: [{ ...member, size: 1 }] });
    await assert.rejects(main(environment));
    assert.deepEqual(readFileSync(path.join(directory, member.file)), contents);
    assert.ok(
      readdirSync(directory).every((name) => !name.startsWith(".asset-")),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("rejects unsafe native declarations before creating a destination or downloading", async (t) => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), "native-declaration-workspace-"),
  );
  const temporary = mkdtempSync(
    path.join(tmpdir(), "native-declaration-temporary-"),
  );
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("invalid declarations cannot fetch");
  });
  try {
    const member = {
      path: "bin/tool",
      file: "tool",
      size: 1,
      sha256: "a".repeat(64),
      executable: true,
    };
    const base = {
      ...asset,
      file: "source.tar",
      executable: false,
      members: [member],
    };
    const environment = {
      RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: temporary,
      INPUT_MANIFEST: "assets.json",
      INPUT_DIRECTORY: path.join(temporary, "uncreated"),
    };
    for (const change of [
      { path: "../outside" },
      { path: "/absolute" },
      { path: "bin/*" },
      { path: "bin/./tool" },
      { file: "../outside" },
      { file: "NUL.exe" },
      { file: "tool." },
      { file: "source.tar" },
      { size: 0 },
      { size: 256 * 1024 * 1024 + 1 },
      { sha256: "invalid" },
      { executable: "true" },
    ]) {
      writeFileSync(
        path.join(workspace, "assets.json"),
        JSON.stringify({
          schema_version: 1,
          assets: [{ ...base, members: [{ ...member, ...change }] }],
        }),
      );
      await assert.rejects(main(environment));
      assert.equal(existsSync(environment.INPUT_DIRECTORY), false);
    }
    writeFileSync(
      path.join(workspace, "assets.json"),
      JSON.stringify({
        schema_version: 1,
        assets: [{ ...base, members: [member, { ...member, file: "TOOL" }] }],
      }),
    );
    await assert.rejects(main(environment));
    assert.equal(existsSync(environment.INPUT_DIRECTORY), false);
    writeFileSync(
      path.join(workspace, "assets.json"),
      JSON.stringify({ schema_version: 1, assets: [base] }),
    );
    await assert.rejects(
      main({ ...environment, INPUT_DIRECTORY: "line\nbreak" }),
    );
    assert.equal(existsSync(path.join(workspace, "line\nbreak")), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});
