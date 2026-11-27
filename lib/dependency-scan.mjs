import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	createReadStream,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { downloadAsset } from "./release-asset.mjs";
import { hostedOsvScannerPins } from "./hosted-compat-pins.mjs";
import {
	findManagedTool,
	loadRegistrySnapshot,
	measureToolVersion,
	resolveTool,
} from "./registry-resolve.mjs";
import { managedRunner } from "./runner-profile.mjs";
import {
	DependencyError,
	findings,
	compareReports,
} from "./dependency-report.mjs";

const refuse = (message) => {
	throw new DependencyError(message);
};

export function scannerPinsFor(environment = process.env) {
	return hostedOsvScannerPins(environment);
}

export function scannerPin(
	platform = process.platform,
	arch = process.arch,
	environment = { RUNNER_ENVIRONMENT: "github-hosted" },
) {
	const pins = hostedOsvScannerPins(environment);
	if (platform !== "linux" || !Object.hasOwn(pins, arch))
		refuse(
			"The dependency guard requires a native Linux x64 or ARM64 runner.",
		);
	return pins[arch];
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

async function preinstalledScanner(pin, environment) {
	const search = environment.PATH || "";
	for (const entry of search.split(path.delimiter)) {
		if (!entry || !path.isAbsolute(entry)) continue;
		const candidate = path.join(entry, "osv-scanner");
		let resolved, metadata;
		try {
			resolved = realpathSync(candidate);
			metadata = statSync(resolved);
		} catch {
			continue;
		}
		if (!metadata.isFile() || metadata.size !== pin.size) continue;
		if ((await checksum(resolved)) !== pin.sha256) continue;
		const version = spawnSync(resolved, ["--version"], {
			encoding: "utf8",
			timeout: 10000,
			maxBuffer: 65536,
			env: { ...environment, DO_NOT_TRACK: "1" },
		});
		if (
			!version.error &&
			version.status === 0 &&
			version.stdout.split(/\r?\n/)[0] === `osv-scanner version: ${pin.version}`
		)
			return resolved;
	}
	return null;
}

export async function prepareScanner(directory, environment = process.env, pin = null) {
	const snapshot = loadRegistrySnapshot(environment);
	if (!pin && environment.RUNNER_ENVIRONMENT && managedRunner(environment.RUNNER_ENVIRONMENT, environment.INPUT_MANAGED)) {
		if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
			refuse("The dependency guard requires a native Linux x64 or ARM64 runner.");
		try {
			return findManagedTool("osv-scanner", { environment, snapshot }).binary;
		} catch (error) {
			refuse(error.message);
		}
	}
	const resolvedPin = pin ?? scannerPin(process.platform, process.arch, environment);
	if (snapshot && !pin) resolveTool(snapshot, "osv-scanner", resolvedPin.version);
	const existing = await preinstalledScanner(resolvedPin, environment);
	if (existing) return existing;
	const binary = path.join(directory, "osv-scanner");
	const declared = registry(environment);
	if (declared) {
		const url = `${declared}/github-releases/sha256/${resolvedPin.sha256}/${resolvedPin.repository}/releases/download/${resolvedPin.tag}/${resolvedPin.name}`;
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
				String(resolvedPin.size),
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
	} else await downloadAsset(resolvedPin, binary, environment.GH_TOKEN);
	const metadata = lstatSync(binary);
	if (
		!metadata.isFile() ||
		metadata.nlink !== 1 ||
		metadata.size !== resolvedPin.size ||
		(await checksum(binary)) !== resolvedPin.sha256
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
			`osv-scanner version: ${resolvedPin.version}`
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
function databaseCacheRoot(environment, day) {
	const root = environment.NDDEV_BUILD_CACHE_ROOT || "";
	if (
		!root ||
		!path.isAbsolute(root) ||
		/[\r\n\0]/.test(root) ||
		!/^\d{4}-\d{2}-\d{2}$/.test(day)
	)
		return null;
	const base = path.join(root, "osv-databases");
	try {
		mkdirSync(base, { recursive: true, mode: 0o700 });
		for (const entry of readdirSync(base)) {
			if (entry !== day)
				rmSync(path.join(base, entry), { recursive: true, force: true });
		}
		return path.join(base, day);
	} catch {
		return null;
	}
}

export function fetchDatabases(report, db, declared, environment, day) {
	const ecosystems = new Set();
	for (const source of Array.isArray(report?.results) ? report.results : [])
		for (const entry of Array.isArray(source?.packages) ? source.packages : [])
			ecosystems.add(entry?.package?.ecosystem);
	const cacheDay = databaseCacheRoot(environment, day);
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
		const target = path.join(folder, "all.zip");
		const cached = cacheDay ? path.join(cacheDay, ecosystem, "all.zip") : null;
		if (cached) {
			try {
				const stat = lstatSync(cached);
				if (stat.isFile() && stat.size > 0 && stat.size <= databaseLimit) {
					copyFileSync(cached, target);
					continue;
				}
			} catch {
				// Cache miss; fetch from the declared registry below.
			}
		}
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
				target,
				`${declared}/osv/${day}/${ecosystem}/all.zip`,
			],
			{ env: environment, timeout: 610000, maxBuffer: 1048576 },
		);
		if (response.error || response.status !== 0)
			refuse(
				"The declared registry could not provide a vulnerability database.",
			);
		if (cached) {
			try {
				const cachedFolder = path.dirname(cached);
				mkdirSync(cachedFolder, { recursive: true, mode: 0o700 });
				const stage = `${cached}.${process.pid}.tmp`;
				copyFileSync(target, stage);
				renameSync(stage, cached);
			} catch {
				// Caching is best-effort; the job already has its database copy.
			}
		}
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
					? ["--offline", "--download-offline-databases"]
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
	const measuredVersion = measureToolVersion(binary, "osv-scanner", environment);
	const isManaged = Boolean(
		environment.RUNNER_ENVIRONMENT &&
			managedRunner(environment.RUNNER_ENVIRONMENT, environment.INPUT_MANAGED),
	);
	const scannerInfo = isManaged
		? { version: measuredVersion || "unknown", repository: "google/osv-scanner" }
		: (measuredVersion
			? { ...scannerPin(process.platform, process.arch, environment), version: measuredVersion }
			: scannerPin(process.platform, process.arch, environment));
	return {
		...compareReports(base, head, input.renames),
		databases: frozen,
		scanner: scannerInfo,
	};
}
