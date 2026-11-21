import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
const program = fileURLToPath(new URL("../lib/ssh-connect.mjs", import.meta.url));
const payload = Buffer.from(Array.from({ length: 131072 }, (_, i) => i % 256));
function client(host, port, environment = {}) {
	const child = spawn(process.execPath, [program, host, String(port)], { env: {
		...process.env, HTTPS_PROXY: "", https_proxy: "", NO_PROXY: "", no_proxy: "", ...environment,
	} });
	const out = [], err = [];
	child.stdout.on("data", (bytes) => out.push(bytes));
	child.stderr.on("data", (bytes) => err.push(bytes));
	const result = once(child, "close").then(([code, signal]) => ({ code, signal, out: Buffer.concat(out), err: Buffer.concat(err).toString() }));
	return { child, result };
}
async function fixture(server, run) {
	const sockets = new Set();
	server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try { await run(server.address().port, sockets); }
	finally { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); }
}

test("the CONNECT relay preserves binary bytes and the response head", async () => {
	const banner = Buffer.from([0, 255, 10, 13, 128]);
	const server = http.createServer();
	server.on("connect", (request, socket) => {
		assert.equal(request.url, "ssh.github.com:443");
		assert.equal(request.headers["proxy-authorization"], "Basic Zml4dHVyZTpzZWNyZXQ=");
		socket.write(Buffer.concat([Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n"), banner]));
		socket.pipe(socket);
	});
	await fixture(server, async (port) => {
		const { child, result } = client("ssh.github.com", 443, { HTTPS_PROXY: `http://fixture:secret@127.0.0.1:${port}` });
		child.stdin.end(payload);
		const got = await result;
		assert.equal(got.code, 0, got.err);
		assert.deepEqual(got.out, Buffer.concat([banner, payload]));
	});
});
test("direct and matching NO_PROXY routes preserve the same bytes", async () => {
	await fixture(net.createServer((socket) => socket.pipe(socket)), async (port) => {
		for (const environment of [{}, { HTTPS_PROXY: "http://invalid.invalid:1", NO_PROXY: `127.0.0.1:${port}` }, { https_proxy: "http://invalid.invalid:1", no_proxy: "*" }]) {
			const { child, result } = client("127.0.0.1", port, environment);
			child.stdin.end(payload);
			const got = await result;
			assert.equal(got.code, 0, got.err);
			assert.deepEqual(got.out, payload);
		}
	});
});
test("a refused proxy emits no credential, response body or tunneled bytes", async () => {
	const server = http.createServer();
	server.on("connect", (_, socket) => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 14\r\n\r\nprivate detail"));
	await fixture(server, async (port) => {
		const { child, result } = client("ssh.github.com", 443, { HTTPS_PROXY: `http://fixture:secret@127.0.0.1:${port}` });
		child.stdin.end();
		const got = await result;
		assert.equal(got.code, 1);
		assert.equal(got.out.length, 0);
		assert.equal(got.err, "SSH proxy connection failed.\n");
	});
});
test("a missing CONNECT response has a real bounded wait", { timeout: 25000 }, async () => {
	await fixture(net.createServer(() => {}), async (port) => {
		const start = performance.now();
		const { child, result } = client("ssh.github.com", 443, { HTTPS_PROXY: `http://127.0.0.1:${port}` });
		child.stdin.end();
		const got = await result;
		assert.equal(got.code, 1);
		assert.ok(performance.now() - start < 22000);
		assert.equal(got.err, "SSH proxy connection failed.\n");
	});
});
test("cancellation closes the tunnel and its child", { timeout: 10000 }, async (t) => {
	let accept;
	const connected = new Promise((resolve) => { accept = resolve; });
	const server = http.createServer();
	server.on("connect", (_, socket) => { socket.write("HTTP/1.1 200 OK\r\n\r\n"); accept(socket); });
	await fixture(server, async (port) => {
		const { child, result } = client("ssh.github.com", 443, { HTTPS_PROXY: `http://127.0.0.1:${port}` });
		t.after(() => child.kill("SIGKILL"));
		const socket = await connected;
		socket.resume();
		// Windows terminates the process directly; its TCP peer can receive a reset.
		let socketError;
		socket.on("error", (error) => { socketError = error; });
		socket.once("end", () => socket.end());
		const closed = new Promise((resolve) => socket.once("close", resolve));
		assert.equal(child.kill("SIGTERM"), true);
		await result;
		await closed;
		if (socketError) {
			assert.equal(process.platform, "win32");
			assert.equal(socketError.code, "ECONNRESET");
		}
	});
});
test("the end of a finished session closes the tunnel quietly", { timeout: 10000, skip: process.platform === "win32" ? "Windows has no SIGHUP" : false }, async (t) => {
	let accept;
	const connected = new Promise((resolve) => { accept = resolve; });
	const server = http.createServer();
	server.on("connect", (_, socket) => { socket.write("HTTP/1.1 200 OK\r\n\r\n"); accept(socket); });
	await fixture(server, async (port) => {
		const { child, result } = client("ssh.github.com", 443, { HTTPS_PROXY: `http://127.0.0.1:${port}` });
		t.after(() => child.kill("SIGKILL"));
		const socket = await connected;
		socket.resume();
		socket.once("end", () => socket.end());
		const closed = new Promise((resolve) => socket.once("close", resolve));
		assert.equal(child.kill("SIGHUP"), true);
		const { code, err } = await result;
		await closed;
		assert.equal(err, "");
		assert.equal(code, 0);
	});
});

test("invalid routes and injected destinations refuse without exposing the input", async () => {
	for (const [host, port, address] of [["ssh.github.com", 443, "file:///private/secret"], ["bad\r\nheader", 443, "http://127.0.0.1:1"], ["ssh.github.com", 0, "http://127.0.0.1:1"]]) {
		const { child, result } = client(host, port, { HTTPS_PROXY: address });
		child.stdin.end();
		const got = await result;
		assert.equal(got.code, 1);
		assert.equal(got.out.length, 0);
		assert.equal(got.err, "SSH proxy connection failed.\n");
	}
});

test("an HTTPS proxy uses its trusted certificate and refuses an untrusted one", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "ssh-proxy-tls-"));
	try {
		const key = path.join(root, "key.pem"), cert = path.join(root, "cert.pem");
		const config = path.join(root, "certificate.conf");
		// The config-file interface works with both OpenSSL and the macOS LibreSSL tool.
		writeFileSync(config, "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=localhost\n[extensions]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=IP:127.0.0.1\n");
		execFileSync("openssl", ["req", "-new", "-x509", "-sha256", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-config", config], { stdio: "pipe" });
		const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) });
		server.on("connect", (_, socket) => { socket.write("HTTP/1.1 200 OK\r\n\r\n"); socket.pipe(socket); });
		await fixture(server, async (port) => {
			for (const trusted of [true, false]) {
				const { child, result } = client("ssh.github.com", 443, { HTTPS_PROXY: `https://127.0.0.1:${port}`, NODE_EXTRA_CA_CERTS: trusted ? cert : "", NODE_TLS_REJECT_UNAUTHORIZED: "1" });
				child.stdin.end(trusted ? payload : undefined);
				const got = await result;
				assert.equal(got.code, trusted ? 0 : 1, got.err);
				assert.deepEqual(got.out, trusted ? payload : Buffer.alloc(0));
			}
		});
	} finally { rmSync(root, { recursive: true, force: true }); }
});
