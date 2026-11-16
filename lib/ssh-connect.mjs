// OpenSSH ProxyCommand: a binary-safe tunnel through the execution provider's HTTP proxy.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { urlToHttpOptions } from "node:url";

const [host, textPort] = process.argv.slice(2);
const port = Number(textPort);
let socket;
let request;
let finished = false;
const timer = setTimeout(() => fail(), 15000);
function fail() {
	if (finished) return;
	finished = true;
	clearTimeout(timer);
	socket?.destroy();
	request?.destroy();
	process.stdin.destroy();
	// Errors can include proxy URLs, credentials and response bodies. None are diagnostic data.
	process.stderr.write("SSH proxy connection failed.\n");
	process.exitCode = 1;
}
function relay(stream, head = Buffer.alloc(0)) {
	if (finished) { stream.destroy(); return; }
	clearTimeout(timer);
	socket = stream;
	socket.on("error", fail);
	socket.on("end", () => process.stdin.destroy());
	if (head.length) process.stdout.write(head);
	process.stdin.pipe(socket);
	socket.pipe(process.stdout);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
	process.once(signal, fail);
process.stdin.on("error", fail);
process.stdout.on("error", fail);
try {
	if (!host || !/^[a-z0-9.-]+$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error();
	const bypass = (process.env.NO_PROXY || process.env.no_proxy || "")
		.split(",")
		.some((entry) => {
			const item = entry.trim().toLowerCase();
			if (item === "*") return true;
			const match = /^([^:]+)(?::([0-9]+))?$/.exec(item);
			if (!match || (match[2] && Number(match[2]) !== port)) return false;
			const name = match[1].replace(/^\./, "");
			return name !== "" && (host.toLowerCase() === name || host.toLowerCase().endsWith(`.${name}`));
		});
	const address = process.env.HTTPS_PROXY || process.env.https_proxy;
	if (!address || bypass) {
		socket = net.connect({ host, port });
		socket.on("error", fail);
		socket.once("connect", () => relay(socket));
	} else {
		const proxy = new URL(address);
		if (!["http:", "https:"].includes(proxy.protocol) || proxy.pathname !== "/" || proxy.search || proxy.hash)
			throw new Error();
		const headers = { Host: `${host}:${port}` };
		if (proxy.username || proxy.password)
			headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
		const transport = proxy.protocol === "https:" ? https : http;
		const proxyHost = urlToHttpOptions(proxy).hostname;
		request = transport.request({
			hostname: proxyHost, servername: net.isIP(proxyHost) ? "" : proxyHost, port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
			method: "CONNECT", path: `${host}:${port}`, headers, agent: false, maxHeaderSize: 16384,
		});
		request.on("error", fail);
		request.once("connect", (response, stream, head) => {
			if (response.statusCode !== 200) { stream.destroy(); fail(); return; }
			relay(stream, head);
		});
		request.end();
	}
} catch { fail(); }
