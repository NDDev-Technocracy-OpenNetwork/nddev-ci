import { execFile, spawnSync } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const standardUpdate = ["-c", "submodule.fetchJobs=0", "submodule", "update", "--init", "--depth", "1", "--quiet"];

async function git(directory, args, label, env = process.env) {
	try {
		const { stdout } = await execute("git", args, { cwd: directory, env, maxBuffer: 16 * 1024 * 1024 });
		return stdout;
	} catch {
		// Git can include a credential-helper URL in stderr.
		throw new Error(label);
	}
}

async function entry(path) {
	try {
		return await lstat(path);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

async function emptyPath(root, target) {
	const name = relative(root, target);
	if (!name || isAbsolute(name) || name.split(sep).includes("..")) return false;

	let directory = root;
	for (const part of name.split(sep)) {
		directory = join(directory, part);
		const known = await entry(directory);
		if (!known) return true;
		if (!known.isDirectory()) return false;
	}
	return (await readdir(target)).length === 0;
}

function supportsRevision(directory) {
	const help = spawnSync("git", ["clone", "-h"], {
		cwd: directory,
		env: { ...process.env, LC_ALL: "C" },
		encoding: "utf8",
	});
	return /--(?:\[no-\])?revision\b/.test((help.stdout ?? "") + (help.stderr ?? ""));
}

function gitlinks(tree) {
	return tree.split("\0").filter((line) => line.startsWith("160000 commit ")).map((line) => {
		const tab = line.indexOf("\t");
		return { sha: line.slice("160000 commit ".length, tab), path: line.slice(tab + 1) };
	});
}

function submoduleNames(configuration) {
	return new Map(configuration.split("\0").filter(Boolean).map((item) => {
		const newline = item.indexOf("\n");
		return [item.slice(newline + 1), item.slice("submodule.".length, newline - ".path".length)];
	}));
}

async function clonePin(root, module) {
	const directory = join(root, module.path);
	const url = (await git(root, ["config", "--local", "--get", "submodule." + module.name + ".url"],
		"Could not read the registered origin for " + module.path)).trim();
	await git(root, ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth=1",
		"--revision=" + module.sha, "--origin", "origin", "--", url, directory],
		"Could not clone the recorded revision of " + module.path, { ...process.env, GIT_PROTOCOL_FROM_USER: "0" });

	const [revision, origin] = await Promise.all([
		git(directory, ["rev-parse", "HEAD"], "Could not read the checked-out revision of " + module.path),
		git(directory, ["config", "--local", "--get", "remote.origin.url"], "Could not read the origin of " + module.path),
	]);
	if (revision.trim() !== module.sha || origin.trim() !== url) {
		throw new Error("Checked-out revision or origin differs for " + module.path);
	}
}

export async function materializeSubmodules(workspace) {
	const root = await realpath(workspace);
	const standard = async () => {
		await git(root, standardUpdate, "The standard submodule update failed.");
		return "standard";
	};

	const links = gitlinks(await git(root, ["ls-tree", "-r", "-z", "HEAD"], "Could not read the checkout gitlinks."));
	if (links.length === 0) return "none";
	if (!supportsRevision(root)) return standard();

	const modulesDir = (await git(root, ["rev-parse", "--git-path", "modules"], "Could not locate the submodule Git directory.")).trim();
	if (await entry(resolve(root, modulesDir))) return standard();
	for (const link of links) {
		if (!await emptyPath(root, resolve(root, link.path))) return standard();
	}
	const paths = links.map((entry) => entry.path);
	const unchanged = spawnSync("git", ["diff", "--quiet", "HEAD", "--", ".gitmodules", ...paths], { cwd: root });
	if (unchanged.status !== 0) return standard();

	const names = submoduleNames(await git(root, ["config", "--null", "--blob", "HEAD:.gitmodules",
		"--get-regexp", "^submodule\\..*\\.path$"], "Could not read the recorded submodule declarations."));
	const modules = links.map((link) => ({ ...link, name: names.get(link.path) }));
	if (modules.some((module) => !module.name)) throw new Error("A gitlink has no submodule declaration.");

	// Let Git initialize and resolve declared URLs, including relative ones, as usual.
	await git(root, ["submodule", "init", "--", ...paths], "Could not register the submodules.");
	const workers = availableParallelism();
	for (let first = 0; first < modules.length; first += workers) {
		const batch = await Promise.allSettled(modules.slice(first, first + workers).map((module) => clonePin(root, module)));
		const failure = batch.find((result) => result.status === "rejected");
		if (failure) throw failure.reason;
	}
	await git(root, ["submodule", "absorbgitdirs", "--", ...paths], "Could not register the exact submodule Git directories.");
	return "exact";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const started = performance.now();
	try {
		const mode = await materializeSubmodules(process.env.GITHUB_WORKSPACE ?? process.cwd());
		console.log("Submodule setup: " + mode + " (" + ((performance.now() - started) / 1000).toFixed(2) + "s)");
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
