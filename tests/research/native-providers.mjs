// One-off qualification of existing hosted programs. No system provider is installed or changed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { main as assets } from "../../actions/release-assets/run.mjs";

assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "native-provider-"));
const manifest = path.join(process.env.GITHUB_WORKSPACE, `.native-provider-${randomUUID()}.json`);
const environment = { ...process.env, DO_NOT_TRACK: "1", BUN_DO_NOT_TRACK: "1", TZ: "UTC" };
function run(program, args, cwd = root, input) {
  const result = spawnSync(program, args, { cwd, env: { ...environment, GIT_AUTHOR_NAME: "provider fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "provider fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }, input, timeout: 100000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true });
  assert.ifError(result.error);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function command(name) {
  const extensions = process.platform === "win32" ? [".exe", ".com", ""] : [""];
  for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!folder) continue;
    for (const suffix of extensions) {
      const candidate = path.join(folder, name + suffix);
      try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return path.resolve(candidate); } catch {}
    }
  }
}
async function sha(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function localProvider(file) {
  if (process.platform === "linux") {
    const owner = run("dpkg-query", ["-S", file]);
    const names = owner.status === 0 ? [...new Set(owner.stdout.trim().split("\n").map((line) => line.split(": ")[0]))] : [];
    return { kind: names.length ? "dpkg" : "runner-image", packages: names.map((name) => run("dpkg-query", ["-W", "-f=${binary:Package}=${Version}\n", name]).stdout.trim()) };
  }
  if (process.platform === "darwin") {
    const receipt = file.match(/^(.*\/Cellar\/[^/]+\/[^/]+)\//)?.[1];
    let bottle;
    if (receipt && fs.existsSync(path.join(receipt, "INSTALL_RECEIPT.json"))) {
      const value = JSON.parse(fs.readFileSync(path.join(receipt, "INSTALL_RECEIPT.json"), "utf8"));
      bottle = { prefix: receipt, built_as_bottle: value.built_as_bottle, poured_from_bottle: value.poured_from_bottle, source: value.source };
    }
    const signed = run("codesign", ["-d", "-v", file]);
    return { kind: bottle ? "homebrew-bottle" : "apple-os-or-command-line-tools", bottle, signature: signed.stderr.split("\n").filter((line) => /^(Identifier|Format|CodeDirectory|Signature|Authority|TeamIdentifier)=/.test(line)) };
  }
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "(Get-Item -LiteralPath $env:NDDEV_TOOL_PROBE_PATH).VersionInfo | Select-Object FileVersion,ProductVersion,ProductName,CompanyName | ConvertTo-Json -Compress"], { env: { ...environment, NDDEV_TOOL_PROBE_PATH: file }, encoding: "utf8", timeout: 30000, maxBuffer: 65536, windowsHide: true });
  return { kind: "windows-file-version", status: result.status, metadata: result.stdout.trim() };
}
const tools = {};
const checks = {};
try {
  for (const [name, args] of [["git", ["--version"]], ["curl", ["--version"]], ["tar", ["--version"]], ["zip", ["-v"]], ["unzip", ["-v"]], ["gzip", ["--version"]], ["xz", ["--version"]]]) {
    const selected = command(name);
    if (!selected) { tools[name] = { available: false }; continue; }
    const file = fs.realpathSync(selected);
    const version = run(selected, args);
    tools[name] = { available: true, selected, canonical: file, bytes: fs.statSync(file).size, sha256: await sha(file), version_status: version.status, version: version.stdout.slice(0,6000), version_diagnostics: version.stderr.slice(0,1000), provider: localProvider(file) };
  }
  assert(tools.git.available && tools.tar.available && tools.curl.available);
  const repo = path.join(root, "git source with spaces"); fs.mkdirSync(repo);
  assert.equal(run(tools.git.selected, ["-c", "init.defaultBranch=fixture", "init", "--quiet"], repo).status, 0);
  fs.writeFileSync(path.join(repo, "payload"), "committed source\n");
  assert.equal(run(tools.git.selected, ["add", "payload"], repo).status, 0);
  const tree = run(tools.git.selected, ["write-tree"], repo).stdout.trim();
  const commit = run(tools.git.selected, ["-c", "commit.gpgsign=false", "commit-tree", tree, "-m", "provider fixture"], repo).stdout.trim();
  assert(/^[a-f0-9]{40}$/.test(commit));
  assert.equal(run(tools.git.selected, ["update-ref", "HEAD", commit], repo).status, 0);
  assert.equal(run(tools.git.selected, ["show", `${commit}:payload`], repo).stdout, "committed source\n");
  assert.equal(run(tools.git.selected, ["diff", "--quiet"], repo).status, 0);
  fs.writeFileSync(path.join(repo, "payload"), "working change\n");
  assert.equal(run(tools.git.selected, ["diff", "--quiet"], repo).status, 1);
  assert.notEqual(run(tools.git.selected, ["cat-file", "-e", "f".repeat(40)], repo).status, 0);
  checks.git_committed_dirty_and_missing_object = true;

  const txz = path.join(root, "inert.tar.xz");
  fs.writeFileSync(txz, Buffer.from("/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AHJdADgYS5l1D0YHqFntLNVAICpAg4RX6LQ9IFtkZiFVU/I5yf0SpHDfKj4L6o9wZAM/QCEw7P+AW5QvrMW9wVlRUetNQm/a6P+maZwOyB5hhSH9kk/WUo0ERt+qK3MO35Zm2nj64BDanWd/5ovuY5A1Dl0dAAAAALhGnZGF6dihAAGOAYBQAABOEGpbscRn+wIAAAAABFla", "base64"));
  const unpacked = run(tools.tar.selected, ["-xOf", txz, "--", "payload"]);
  assert.equal(unpacked.status, 0, unpacked.stderr);
  assert.equal(unpacked.stdout, "native-provider-contract\n");
  assert.notEqual(run(tools.tar.selected, ["-xOf", txz, "--", "missing-member"]).status, 0);
  fs.writeFileSync(path.join(root, "truncated.tar.xz"), fs.readFileSync(txz).subarray(0, 50));
  assert.notEqual(run(tools.tar.selected, ["-xOf", path.join(root, "truncated.tar.xz"), "--", "payload"]).status, 0);
  checks.tar_xz_exact_stdout_missing_and_truncated = true;

  const pin = JSON.parse(fs.readFileSync(new URL("../../actions/recipe/just.json", import.meta.url), "utf8"));
  const selected = pin.targets[`${process.platform}-${process.arch}`]; assert(selected);
  const executable = process.platform === "win32" ? "qualified-just.exe" : "qualified-just";
  fs.writeFileSync(manifest, JSON.stringify({ schema_version: 1, assets: [{ repository: pin.repository, asset: selected.asset, size: selected.size, sha256: selected.sha256, file: selected.name, members: [{ path: process.platform === "win32" ? "just.exe" : "just", file: executable, size: selected.binary_size, sha256: selected.binary_sha256, executable: true }] }] }), { flag: "wx" });
  const native = path.join(root, "native assets");
  const assetEnv = { ...process.env, INPUT_MANIFEST: manifest, INPUT_DIRECTORY: native, "INPUT_ADD-TO-PATH": "false", "INPUT_GITHUB-TOKEN": process.env.GH_TOKEN ?? process.env["INPUT_GITHUB-TOKEN"], GITHUB_OUTPUT: "", GITHUB_PATH: "" };
  await assets(assetEnv); await assets(assetEnv);
  assert.equal(run(path.join(native, executable), ["--version"]).stdout.trim(), `just ${pin.version}`);
  checks.library_native_archive_member_hash_execution_and_warm_reuse = true;

  if (tools.zip.available && tools.unzip.available) {
    const directory = path.join(root, "zip source"); fs.mkdirSync(directory);
    for (const file of ["payload", ".hidden"]) { fs.writeFileSync(path.join(directory, file), `inert ${file}\n`); fs.utimesSync(path.join(directory, file), new Date("2020-01-02T03:04:06Z"), new Date("2020-01-02T03:04:06Z")); }
    for (const name of ["first.zip", "second.zip"]) assert.equal(run(tools.zip.selected, ["-X", "-9", path.join(root,name), "payload", ".hidden"], directory).status, 0);
    assert.equal(await sha(path.join(root,"first.zip")), await sha(path.join(root,"second.zip")));
    assert.equal(run(tools.unzip.selected, ["-p", path.join(root,"first.zip"), "payload"]).stdout, "inert payload\n");
    assert.equal(run(tools.unzip.selected, ["-t", path.join(root,"first.zip")]).status, 0);
    assert(run(tools.unzip.selected, ["-Z1", path.join(root,"first.zip")]).stdout.split(/\r?\n/).includes(".hidden"));
    fs.writeFileSync(path.join(root,"truncated.zip"),fs.readFileSync(path.join(root,"first.zip")).subarray(0,50));
    assert.notEqual(run(tools.unzip.selected, ["-t", path.join(root,"truncated.zip")]).status, 0);
    checks.zip_repeatability_hidden_stdout_integrity_and_truncation = true;
  } else checks.zip_companion_contract = "not-qualified-native-program-missing";

  const options = ["--head", "--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--max-time", "30", "--retry", "2", "--output", path.join(root,"http-headers")];
  const tls = run(tools.curl.selected, [...options, "https://www.python.org/"]);
  assert.equal(tls.status, 0, tls.stderr);
  assert.notEqual(run(tools.curl.selected, [...options, `https://www.python.org/native-provider-missing-${randomUUID()}`]).status, 0);
  checks.curl_system_tls_and_http_failure = true;
  for (const value of Object.values(tools)) if (value.available) assert.equal(await sha(value.canonical), value.sha256);
  const operatingSystem = process.platform === "darwin" ? { version: run("sw_vers",["-productVersion"]).stdout.trim(), build: run("sw_vers",["-buildVersion"]).stdout.trim() } : process.platform === "linux" ? { os_release: fs.readFileSync("/etc/os-release","utf8") } : { version: run("cmd",["/c","ver"]).stdout.trim() };
  console.log(JSON.stringify({ research_only: true, platform: process.platform, architecture: process.arch, node: process.versions.node, image_os: process.env.ImageOS, image_version: process.env.ImageVersion, operatingSystem, tools, checks, provider_bytes_unchanged: true }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(manifest, { force: true });
  console.log(JSON.stringify({ cleanup: !fs.existsSync(root) && !fs.existsSync(manifest) }));
}
