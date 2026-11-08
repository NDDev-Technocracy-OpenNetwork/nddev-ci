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
} from "node:fs";
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
