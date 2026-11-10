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
import { createServer } from "node:http";
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

test("a failed storage socket cannot leave the API redirect as the download result", {timeout: 20000}, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-redirect-transport-"));
  const nativeFetch = globalThis.fetch, requests = [], apiCredentials = [], storageCredentials = [];
  const listen = async (handler) => {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {server, url: `http://127.0.0.1:${server.address().port}`};
  };
  const api = await listen((req, res) => {
    apiCredentials.push(req.headers.authorization);
    res.writeHead(302, {location: "https://release-assets.githubusercontent.com/asset?signature=fixture-private"});
    res.end();
  });
  const storage = await listen((req) => {
    storageCredentials.push(req.headers.authorization);
    req.socket.destroy();
  });
  t.mock.method(globalThis, "fetch", (url, options) => {
    const value = String(url), source = value.startsWith("https://api.github.com/");
    requests.push({url: value, source, options});
    // Keep the actual origin checks, but exercise the fetch rejection with a real local socket.
    return nativeFetch(source ? api.url : storage.url, options);
  });
  try {
    const target = path.join(directory, "tool");
    await assert.rejects(downloadAsset(asset, target, "test-read-token"), (error) => {
      assert.match(error.message, /Pinned release asset transport did not complete/);
      assert.doesNotMatch(error.message, /HTTP 302|fixture-private|test-read-token/);
      return true;
    });
    assert.equal(requests.filter((r) => r.source).length, 4);
    assert.equal(requests.filter((r) => !r.source).length, 4);
    assert.ok(requests.filter((r) => r.source).every((r) => r.url === "https://api.github.com/repos/example/tool/releases/assets/123"));
    assert.ok(requests.filter((r) => !r.source).every((r) => r.options.redirect === "error" && r.options.headers.Authorization === undefined));
    assert.ok(apiCredentials.every((value) => value === "Bearer test-read-token"));
    assert.ok(storageCredentials.length > 0 && storageCredentials.every((value) => value === undefined));
    assert.equal(existsSync(target), false);
  } finally {
    for (const {server} of [api, storage]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(directory, {recursive: true, force: true});
  }
});

for (const failure of ["socket", "timeout"]) {
  test(`partial storage body ${failure} preserves the transfer boundary`, {timeout: 20000}, async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "release-body-transport-"));
    const target = path.join(directory, "tool"), requests = [], credentials = [];
    const nativeFetch = globalThis.fetch, nativeTimeout = AbortSignal.timeout;
    const server = createServer((req, res) => {
      credentials.push({source: req.url === "/api", authorization: req.headers.authorization});
      assert.equal(existsSync(target), false, "partial bytes must be removed before another request");
      if (req.url === "/api") {
        res.writeHead(302, {location: "https://release-assets.githubusercontent.com/body?signature=fixture-private"});
        res.end();
      } else {
        const attempt = credentials.filter((entry) => !entry.source).length;
        res.writeHead(200, {"content-length": bytes.length});
        if (failure === "socket" && attempt === 2) res.end(bytes);
        else {
          res.write(bytes.subarray(0, 3));
          if (failure === "socket") setTimeout(() => res.destroy(), 30);
          // The timeout variant leaves an actual response body open until its signal aborts.
        }
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    if (failure === "timeout") t.mock.method(AbortSignal, "timeout", (milliseconds) => {
      assert.equal(milliseconds, 30000, "the production transfer deadline must stay unchanged");
      return nativeTimeout(150);
    });
    t.mock.method(globalThis, "fetch", (url, options) => {
      const source = String(url).startsWith("https://api.github.com/");
      requests.push({url: String(url), source, options});
      return nativeFetch(`http://127.0.0.1:${server.address().port}/${source ? "api" : "body"}`, options);
    });
    try {
      if (failure === "socket") {
        await downloadAsset(asset, target, "test-read-token");
        assert.deepEqual(readFileSync(target), bytes, "a retry must reset its file, size and digest");
        assert.deepEqual(readdirSync(directory), ["tool"]);
      } else {
        await assert.rejects(downloadAsset(asset, target, "test-read-token"), (error) => {
          assert.match(error.message, /Pinned release asset transport did not complete/);
          assert.doesNotMatch(error.message, /operation was aborted|fixture-private|test-read-token/);
          return true;
        });
        assert.deepEqual(readdirSync(directory), [], "an exhausted transfer must leave no partial file");
      }
      const attempts = failure === "socket" ? 2 : 4;
      assert.equal(requests.filter((entry) => entry.source).length, attempts);
      assert.equal(requests.filter((entry) => !entry.source).length, attempts);
      assert.ok(requests.filter((entry) => entry.source).every((entry) => entry.url === "https://api.github.com/repos/example/tool/releases/assets/123"));
      assert.ok(requests.filter((entry) => !entry.source).every((entry) => entry.options.redirect === "error" && entry.options.headers.Authorization === undefined));
      assert.ok(credentials.filter((entry) => entry.source).every((entry) => entry.authorization === "Bearer test-read-token"));
      assert.ok(credentials.filter((entry) => !entry.source).every((entry) => entry.authorization === undefined));
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(directory, {recursive: true, force: true});
    }
  });
}

for (const variant of ["redirect", "size", "incomplete", "digest", "forbidden", "missing body"]) {
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
      if (variant === "missing body") return new Response(null);
      if (variant === "incomplete") return new Response(bytes.subarray(0, 3));
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
      assert.deepEqual(readdirSync(directory), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("download failures never delete or replace a pre-existing destination", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-existing-"));
  const target = path.join(directory, "tool");
  writeFileSync(target, "keep existing bytes");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests += 1; return new Response(bytes); });
  try {
    await assert.rejects(downloadAsset(asset, target, ""), {code: "EEXIST"});
    assert.equal(requests, 1);
    assert.equal(readFileSync(target, "utf8"), "keep existing bytes");
    assert.deepEqual(readdirSync(directory), ["tool"]);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test("declared registries receive no GitHub token and cannot switch sources", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "registry-asset-"));
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({url: String(url), options});
    return requests.length === 1 ? new Response(bytes) : new Response(null, {status: 403});
  });
  const pinned = {...asset, tag: "v1.0.0", name: "tool.tar.gz"};
  try {
    await downloadAsset(pinned, path.join(directory, "tool"), "test-read-token", "http://127.0.0.1:8080/cache");
    assert.equal(requests[0].url, `http://127.0.0.1:8080/cache/github-releases/sha256/${asset.sha256}/example/tool/releases/download/v1.0.0/tool.tar.gz`);
    assert.equal(requests[0].options.headers.Authorization, undefined);
    await assert.rejects(downloadAsset(pinned, path.join(directory, "other"), "test-read-token", "http://127.0.0.1:8080/cache"));
    assert.equal(requests.length, 2);
    await assert.rejects(downloadAsset(asset, path.join(directory, "missing-identity"), "test-read-token", "http://127.0.0.1:8080/cache"));
    assert.equal(requests.length, 2);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

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
    await main({...environment, RUNNER_ENVIRONMENT: "self-hosted", INPUT_MANAGED: "false"});
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
