import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
const prepare = readFileSync(new URL("../actions/prepare/action.yml", import.meta.url), "utf8");
const complete = readFileSync(new URL("../actions/complete/action.yml", import.meta.url), "utf8");
const script = prepare.split("    - name: Read keys\n")[1].split("      run: |\n")[1].split("\n    - name:")[0]
	.split("\n").map((line) => line.replace(/^        /, "")).join("\n");
const cleanup = complete.split("    - name: Remove read keys\n")[1].split("      run: ")[1].split("\n")[0];
const action = fileURLToPath(new URL("../actions/prepare", import.meta.url));
function command(program, args, options) {
	const result = spawnSync(program, args, { encoding: "utf8", ...options });
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${result.stderr}\nGenerated command: ${options?.env?.GIT_SSH_COMMAND ?? "none"}`);
	return result.stdout;
}
async function fixture(proxy, run, { repositories = ["Fixture/one", "Fixture/two"], transform = (value) => value, success = true } = {}) {
	const root = mkdtempSync(path.join(tmpdir(), "read keys "));
	try {
		const privateKeys = [];
		for (let i = 0; i < 2; i++) {
			const file = path.join(root, `key${i}`);
			command("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]);
			privateKeys.push(readFileSync(file, "utf8"));
		}
		const output = path.join(root, "env");
		const environment = {
			...process.env, READ_KEYS: transform(repositories.map((repository, i) => `${repository}\n${privateKeys[i]}`).join("")),
			READ_APP_CLIENT_ID: "", RUNNER_OS: process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux", RUNNER_TEMP: root, GITHUB_ENV: output, GITHUB_ACTION_PATH: action,
			HTTPS_PROXY: proxy, https_proxy: "", NO_PROXY: "", no_proxy: "", SHELL: "/disabled/login/shell",
		};
		const prepared = spawnSync("bash", ["-euo", "pipefail", "-c", script], { env: environment, encoding: "utf8" });
		assert.ifError(prepared.error);
		assert.equal(prepared.status === 0, success, prepared.stderr);
		for (const line of readFileSync(output, "utf8").trim().split(/\r?\n/).filter(Boolean)) {
			const at = line.indexOf("="); environment[line.slice(0, at)] = line.slice(at + 1);
		}
		await run({ root, environment, privateKeys, repositories, prepared });
	} finally { rmSync(root, { recursive: true, force: true }); }
}
for (const proxy of ["", "http://127.0.0.1:12345"])
	test(`the generated read-key config parses with isolated identities and ${proxy ? "declared" : "direct"} transport`, () =>
		fixture(proxy, ({ root, environment, privateKeys }) => {
			for (let i = 0; i < 2; i++) {
				const name = i ? "two" : "one";
				const rewritten = command("git", ["ls-remote", "--get-url", `https://github.com/Fixture/${name}`], { env: environment }).trim();
				const alias = rewritten.split(":")[0];
				const text = command("bash", ["-c", `${environment.GIT_SSH_COMMAND} -G ${alias}`], { env: environment });
				const options = Object.fromEntries(text.trim().split(/\r?\n/).map((line) => { const at = line.indexOf(" "); return [line.slice(0, at), line.slice(at + 1)]; }));
				assert.equal(options.hostname, "ssh.github.com");
				assert.equal(options.port, "443");
				assert.equal(options.user, "git");
				assert.equal(options.hostkeyalias, "github.com");
				assert.ok(["true", "yes"].includes(options.stricthostkeychecking));
				assert.ok(["true", "yes"].includes(options.identitiesonly));
				assert.ok(["true", "yes"].includes(options.batchmode));
				assert.equal(options.connecttimeout, "15");
				assert.equal(options.connectionattempts, "1");
				assert.equal(options.serveraliveinterval, "15");
				assert.equal(options.serveralivecountmax, "3");
				assert.equal(text.split(/\r?\n/).filter((line) => line.startsWith("identityfile ")).length, 1);
				const file = path.join(root, "nddev-ci/ssh", alias);
				const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
				assert.equal(digest(readFileSync(file)), digest(privateKeys[i]));
				if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
				assert.equal(Boolean(options.proxycommand), Boolean(proxy));
				if (proxy) assert.ok(options.proxycommand.includes("ssh-connect.mjs"));
				assert.equal(rewritten, `${alias}:Fixture/${name}`);
			}
			const known = readFileSync(path.join(root, "nddev-ci/ssh/known_hosts"), "utf8");
			assert.match(known, /^github\.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl$/m);
			const config = path.join(root, "nddev-ci/ssh/config");
			const before = readFileSync(config);
			command("bash", ["-euo", "pipefail", "-c", script], { env: environment });
			assert.deepEqual(readFileSync(config), before);
			command("bash", ["-euo", "pipefail", "-c", cleanup], { env: environment });
			assert.equal(existsSync(path.join(root, "nddev-ci/ssh")), false);
		}));

test("the actual Git read invokes the declared route and refuses an untrusted peer with a disabled inherited shell", { timeout: 25000 }, async (t) => {
	const requests = [];
	const sockets = new Set();
	const server = http.createServer();
	server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
	server.on("connect", (request, socket) => {
		requests.push(request.url);
		// End the fixture after its SSH banner; no key exchange or outside connection occurs.
		socket.end("HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-fixture\r\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		await fixture(`http://127.0.0.1:${server.address().port}`, async ({ environment }) => {
			const child = spawn("git", ["ls-remote", "--exit-code", "https://github.com/Fixture/one", "HEAD"], { env: environment, stdio: ["pipe", "ignore", "pipe"] });
			t.after(() => child.kill("SIGKILL"));
			child.stderr.resume();
			child.stdin.end();
			const [code] = await once(child, "close");
			assert.notEqual(code, 0); // The fixture deliberately offers no trusted SSH server.
			assert.deepEqual(requests, ["ssh.github.com:443"]);
		});
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("hyphenated repository names cannot share a read identity alias", () =>
	fixture("", ({ root, environment, repositories, privateKeys }) => {
		const aliases = repositories.map((repository) => command("git", ["ls-remote", "--get-url", `https://github.com/${repository}`], { env: environment }).trim().split(":")[0]);
		assert.equal(new Set(aliases).size, 2);
		for (const [i, alias] of aliases.entries()) {
			const text = command("bash", ["-c", `${environment.GIT_SSH_COMMAND} -G ${alias}`], { env: environment });
			assert.equal(text.split(/\r?\n/).filter((line) => line.startsWith("identityfile ")).length, 1);
			const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
			assert.equal(digest(readFileSync(path.join(root, "nddev-ci/ssh", alias))), digest(privateKeys[i]));
		}
	}, { repositories: ["Fixture-Ab/c", "Fixture/Ab-c"] }));

test("canonical duplicate repositories refuse and remove their partially prepared keys", () =>
	fixture("", ({ root, prepared }) => {
		assert.match(prepared.stdout, /repeats a repository identity/);
		assert.equal(existsSync(path.join(root, "nddev-ci/ssh")), false);
	}, { repositories: ["Fixture/one", "fixture/ONE"], success: false }));
test("a malformed later key removes every partially prepared identity", () =>
	fixture("", ({ root }) => {
		assert.equal(existsSync(path.join(root, "nddev-ci/ssh")), false);
	}, { transform: (value) => value.replace(/-----END OPENSSH PRIVATE KEY-----\s*$/, ""), success: false }));
