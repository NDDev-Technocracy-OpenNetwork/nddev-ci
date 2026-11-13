import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	createReadStream,
	lstatSync,
	mkdirSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { downloadAsset } from "./release-asset.mjs";
import {
	DependencyError,
	findings,
	compareReports,
} from "./dependency-report.mjs";

const scanner = {
	version: "2.7.1",
	repository: "google/osv-scanner",
	tag: "v2.7.1",
};
// One pinned upstream release per supported native Linux architecture.
export const scannerPins = Object.freeze({
	x64: Object.freeze({
		...scanner,
		name: "osv-scanner_linux_amd64",
		asset: 726165286,
		size: 58187936,
		sha256: "fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8",
	}),
	arm64: Object.freeze({
		...scanner,
		name: "osv-scanner_linux_arm64",
		asset: 726165576,
		size: 54198432,
		sha256: "983d22fbad9724514e3fcc6acc83b5fa64c5ffa6b0d9f510028f22c1b223ff81",
	}),
});
const refuse = (message) => {
	throw new DependencyError(message);
};
export function scannerPin(platform = process.platform, arch = process.arch) {
	if (platform !== "linux" || !Object.hasOwn(scannerPins, arch))
		refuse(
			"The dependency guard requires a native Linux x64 or ARM64 runner.",
		);
	return scannerPins[arch];
}
async function checksum(file) {
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(file)) hash.update(bytes);
	return hash.digest("hex");
}

// The declared registry of a managed runner without a final slash, or nothing on a runner
// that has none.
export function registry(environment) {
	if (!environment.NDDEV_CI_ARTIFACT_REGISTRY) return "";
	const base = new URL(environment.NDDEV_CI_ARTIFACT_REGISTRY);
	if (
		!["http:", "https:"].includes(base.protocol) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	)
		refuse("Invalid declared security tool registry.");
	return base.href.replace(/\/$/, "");
}

export async function prepareScanner(directory, environment = process.env) {
	const pin = scannerPin();
	const binary = path.join(directory, "osv-scanner");
	const declared = registry(environment);
	if (declared) {
		const url = `${declared}/github-releases/sha256/${pin.sha256}/${pin.repository}/releases/download/${pin.tag}/${pin.name}`;
		const response = spawnSync(
			"curl",
			[
				"--fail",
				"--silent",
				"--show-error",
				"--location",
				"--max-time",
				"180",
				"--max-filesize",
				String(pin.size),
				"--output",
				binary,
				url,
			],
			{ env: environment, timeout: 190000, maxBuffer: 1048576 },
		);
		if (response.error || response.status !== 0)
			refuse(
				"The declared security tool registry could not provide the pinned scanner.",
			);
	} else await downloadAsset(pin, binary, environment.GH_TOKEN);
	const metadata = lstatSync(binary);
	if (
		!metadata.isFile() ||
		metadata.nlink !== 1 ||
		metadata.size !== pin.size ||
		(await checksum(binary)) !== pin.sha256
	)
		refuse("Security scanner bytes differ from their pin.");
	chmodSync(binary, 0o500);
	const version = spawnSync(binary, ["--version"], {
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 65536,
		env: { ...environment, DO_NOT_TRACK: "1" },
	});
	if (
		version.error ||
		version.status !== 0 ||
		version.stdout.split(/\r?\n/)[0] !==
			`osv-scanner version: ${pin.version}`
	)
		refuse("The native security scanner cannot execute at its pinned version.");
	return binary;
}

async function databases(directory) {
	const entries = [];
	let size = 0;
	async function visit(folder) {
		for (const name of readdirSync(folder).sort()) {
			const file = path.join(folder, name);
			const stat = lstatSync(file);
			if (stat.isDirectory()) await visit(file);
			else {
				if (
					!stat.isFile() ||
					stat.nlink !== 1 ||
					!name.endsWith(".zip") ||
					(size += stat.size) > 4 * 1024 ** 3 ||
					entries.length >= 64
				)
					refuse("Invalid or unbounded security database snapshot.");
				entries.push({
					path: path.relative(directory, file),
					size: stat.size,
					sha256: await checksum(file),
				});
			}
		}
	}
	await visit(directory);
	return entries;
}

// Where the pinned scanner keeps the database of an ecosystem below its local database path.
const databaseFolder = "osv-scalibr";
const databaseLimit = 1024 ** 3;

// On a runner with a declared registry the databases come from it and not from the scanner's own
// download. The scanner names every package's ecosystem even without a database, so the needed
// files are known first; each is the registry's copy of the current UTC day.
export function fetchDatabases(report, db, declared, environment, day) {
	const ecosystems = new Set();
	for (const source of Array.isArray(report?.results) ? report.results : [])
		for (const entry of Array.isArray(source?.packages) ? source.packages : [])
			ecosystems.add(entry?.package?.ecosystem);
	for (const ecosystem of [...ecosystems].sort()) {
		if (
			typeof ecosystem !== "string" ||
			!/^[A-Za-z0-9._:-]{1,64}$/.test(ecosystem)
		)
			refuse(
				"The scanner named an ecosystem the declared registry cannot serve.",
			);
		const folder = path.join(db, databaseFolder, ecosystem);
		mkdirSync(folder, { recursive: true, mode: 0o700 });
		const response = spawnSync(
			"curl",
			[
				"--fail",
				"--silent",
				"--show-error",
				"--max-time",
				"600",
				"--max-filesize",
				String(databaseLimit),
				"--output",
				path.join(folder, "all.zip"),
				`${declared}/osv/${day}/${ecosystem}/all.zip`,
			],
			{ env: environment, timeout: 610000, maxBuffer: 1048576 },
		);
		if (response.error || response.status !== 0)
			refuse(
				"The declared registry could not provide a vulnerability database.",
			);
	}
}

// All inputs are inert lockfile bytes. A single preparation obtains the databases of the union
// of the ecosystems; both comparisons then use --offline against those exact database bytes.
export async function scanSources(
	binary,
	directory,
	input,
	environment = process.env,
	day = new Date().toISOString().slice(0, 10),
) {
	const db = path.join(directory, "database");
	const config = path.join(directory, "empty.toml");
	const union = path.join(directory, "inputs");
	mkdirSync(db, { mode: 0o700 });
	writeFileSync(config, "", { flag: "wx", mode: 0o400 });
	const common = [
		"scan",
		"source",
		"--format=json",
		"--all-packages",
		"--allow-no-lockfiles",
		"--verbosity=error",
		"--no-call-analysis",
		"--no-resolve",
		"--data-source=native",
		"--no-ignore",
		"--config",
		config,
		"--local-db-path",
		db,
	];
	function run(folder, download) {
		return spawnSync(
			binary,
			[
				...common,
				...(download
					? ["--offline-vulnerabilities", "--download-offline-databases"]
					: ["--offline"]),
				"-r",
				folder,
			],
			{
				env: {
					...environment,
					OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: db,
					DO_NOT_TRACK: "1",
				},
				encoding: "utf8",
				timeout: 300000,
				killSignal: "SIGKILL",
				maxBuffer: 64 * 1024 * 1024,
			},
		);
	}
	function scan(folder, download = false) {
		const response = run(folder, download);
		if (
			response.error ||
			![0, 1].includes(response.status) ||
			response.stderr.trim()
		) {
			console.log(
				JSON.stringify({
					dependency_scan: download
						? "database-preparation"
						: "offline-comparison",
					status: response.status,
					diagnostics: response.stderr
						?.slice(-2000)
						.replace(/https?:\/\/\S+/g, "<url>"),
				}),
			);
			refuse(
				"Dependency extraction or vulnerability data was unavailable; no clean comparison was produced.",
			);
		}
		let report;
		try {
			report = JSON.parse(response.stdout);
		} catch {
			refuse("The security scanner returned malformed JSON.");
		}
		return report;
	}
	const all = [
		...input.base.map((e) => `base/${e.path}`),
		...input.head.map((e) => `head/${e.path}`),
	];
	const declared = registry(environment);
	if (declared) {
		// Without a database the scanner fails this run and still reports every package.
		const listed = run(union, false);
		let report;
		try {
			if (listed.error) throw listed.error;
			report = JSON.parse(listed.stdout);
		} catch {
			refuse("The security scanner could not list the packages to look up.");
		}
		fetchDatabases(report, db, declared, environment, day);
	}
	const prepared = findings(scan(union, !declared), union, all);
	const frozen = await databases(db);
	if (prepared.packages && !frozen.length)
		refuse("Vulnerability database preparation produced no database bytes.");
	const base = findings(
		scan(path.join(union, "base")),
		path.join(union, "base"),
		input.base.map((e) => e.path),
	);
	const head = findings(
		scan(path.join(union, "head")),
		path.join(union, "head"),
		input.head.map((e) => e.path),
	);
	if (base.packages + head.packages !== prepared.packages)
		refuse(
			"Dependency extraction changed between preparation and the frozen comparison.",
		);
	if (JSON.stringify(await databases(db)) !== JSON.stringify(frozen))
		refuse("Vulnerability database bytes changed during the comparison.");
	return {
		...compareReports(base, head, input.renames),
		databases: frozen,
		scanner: scannerPin(),
	};
}
