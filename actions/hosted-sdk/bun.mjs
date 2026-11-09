import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ActionError } from "../../lib/release-asset.mjs";
import { selections } from "./run.mjs";

export function asset(release, version, platform, architecture, avx2 = true) {
	const os = { linux: "linux", darwin: "darwin", win32: "windows" }[platform];
	const arch = { x64: "x64", arm64: "aarch64" }[architecture];
	if (!os || !arch)
		throw new ActionError("Bun requires a supported native hosted target.");
	const name = `bun-${os}-${arch}${architecture === "x64" && !avx2 ? "-baseline" : ""}.zip`;
	if (
		release?.tag_name !== `bun-v${version}` ||
		release.draft !== false ||
		release.prerelease !== false ||
		!Array.isArray(release.assets)
	)
		throw new ActionError(
			"The Bun release differs from its exact stable selection.",
		);
	const matches = release.assets.filter((value) => value.name === name);
	if (matches.length !== 1)
		throw new ActionError(
			"The selected Bun release has no unique native target asset.",
		);
	const selected = matches[0];
	if (
		!Number.isSafeInteger(selected.id) ||
		selected.id < 1 ||
		!Number.isSafeInteger(selected.size) ||
		selected.size < 1 ||
		selected.size > 256 * 1024 * 1024 ||
		!/^sha256:[a-f0-9]{64}$/.test(selected.digest)
	)
		throw new ActionError("Bun release asset metadata is incomplete.");
	return {
		repository: "oven-sh/bun",
		tag: release.tag_name,
		asset: selected.id,
		name,
		size: selected.size,
		published_sha256: selected.digest.slice(7),
	};
}

async function api(url, token, accept) {
	for (let attempt = 0; attempt < 4; attempt++) {
		let response;
		try {
			response = await fetch(url, {
				headers: {
					Accept: accept,
					"User-Agent": "nddev-ci",
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				redirect: "manual",
				signal: AbortSignal.timeout(30000),
			});
		} catch {
			if (attempt === 3)
				throw new ActionError(
					"The official Bun asset API could not be reached.",
				);
		}
		if (
			response &&
			(response.ok || [301, 302, 303, 307, 308].includes(response.status))
		)
			return response;
		if (response && ![408, 429, 500, 502, 503, 504].includes(response.status))
			throw new ActionError(
				`The official Bun asset API returned HTTP ${response.status}.`,
			);
		const requested = Number(response?.headers.get("retry-after") ?? 0);
		if (attempt === 3 || !Number.isFinite(requested) || requested > 30)
			throw new ActionError(
				"The official Bun asset API did not provide its pinned source.",
			);
		if (response?.body) await response.body.cancel();
		await delay(Math.max(2 ** attempt, requested) * 1000);
	}
}

export async function main(environment = process.env) {
	const version = selections(environment).bun;
	if (!version || !environment.GITHUB_OUTPUT)
		throw new ActionError(
			"Exact Bun selection and action output are required.",
		);
	const token = environment.SDK_GITHUB_TOKEN;
	const metadata = await api(
		`https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v${version}`,
		token,
		"application/vnd.github+json",
	);
	if (
		metadata.status !== 200 ||
		Number(metadata.headers.get("content-length") ?? 0) > 2 * 1024 * 1024
	)
		throw new ActionError("The official Bun release response is invalid.");
	const chunks = [];
	let size = 0;
	for await (const chunk of metadata.body) {
		size += chunk.length;
		if (size > 2 * 1024 * 1024)
			throw new ActionError("Bun release metadata exceeds its bound.");
		chunks.push(Buffer.from(chunk));
	}
	let release;
	try {
		release = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new ActionError("Invalid official Bun release metadata.");
	}
	const avx2 =
		process.arch !== "x64" ||
		process.platform !== "linux" ||
		/\bavx2\b/.test(readFileSync("/proc/cpuinfo", "utf8"));
	const source = asset(release, version, process.platform, process.arch, avx2);
	const response = await api(
		`https://api.github.com/repos/oven-sh/bun/releases/assets/${source.asset}`,
		token,
		"application/octet-stream",
	);
	const location = response.headers.get("location");
	if (response.body) await response.body.cancel();
	if (
		![301, 302, 303, 307, 308].includes(response.status) ||
		!location ||
		/[\r\n]/.test(location)
	)
		throw new ActionError(
			"Bun's official asset API did not provide its download redirect.",
		);
	const url = new URL(location);
	if (
		url.protocol !== "https:" ||
		!url.hostname.endsWith(".githubusercontent.com") ||
		url.username ||
		url.password ||
		url.hash
	)
		throw new ActionError("Bun asset download is outside its official origin.");
	// The signed redirect is transient transport data, never a durable provider pin.
	console.log(`::add-mask::${url.href.replace(/%/g, "%25")}`);
	appendFileSync(
		environment.GITHUB_OUTPUT,
		`url=${url.href}\nsource=${JSON.stringify(source)}\n`,
	);
	console.log(
		JSON.stringify({
			bun_published_source: source,
			platform: process.platform,
			architecture: process.arch,
		}),
	);
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		await main();
	} catch (error) {
		console.error(
			`::error::${error instanceof ActionError ? error.message : "Bun source resolution failed."}`,
		);
		process.exitCode = 1;
	}
}
