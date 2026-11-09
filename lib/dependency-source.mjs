import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DependencyError } from "./dependency-report.mjs";

// Explicit source scope: these are data inputs understood by the pinned native scanner.
// Installed packages, images, submodules and package execution belong to other checks.
const locks = new Set([
	"Cargo.lock",
	"bun.lock",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"uv.lock",
	"poetry.lock",
	"Pipfile.lock",
	"pdm.lock",
	"pylock.toml",
	"requirements.txt",
	"pubspec.lock",
	"go.mod",
	"composer.lock",
	"Gemfile.lock",
	"gems.locked",
	"mix.lock",
	"conan.lock",
	"cabal.project.freeze",
	"stack.yaml.lock",
	"buildscript-gradle.lockfile",
	"gradle.lockfile",
	"packages.config",
	"packages.lock.json",
	"renv.lock",
]);
const declarations = new Set([
	"Cargo.toml",
	"package.json",
	"pyproject.toml",
	"pubspec.yaml",
	"composer.json",
	"Gemfile",
	"mix.exs",
	"go.sum",
	"bun.lockb",
]);
const limit = 64 * 1024 * 1024;
const refuse = (message) => {
	throw new DependencyError(message);
};

function git(workspace, args, maxBuffer = limit) {
	const result = spawnSync(
		"git",
		["--no-optional-locks", "-c", "core.hooksPath=/dev/null", ...args],
		{
			cwd: workspace,
			encoding: null,
			maxBuffer,
			timeout: 30000,
			env: {
				...process.env,
				GIT_NO_REPLACE_OBJECTS: "1",
				GIT_TERMINAL_PROMPT: "0",
			},
		},
	);
	if (result.error || result.status !== 0)
		refuse("Exact dependency Git inputs are unavailable.");
	return result.stdout;
}
function utf8(bytes) {
	const value = bytes.toString("utf8");
	if (!Buffer.from(value).equals(bytes))
		refuse("Dependency Git paths must be valid UTF-8.");
	return value;
}
function location(value) {
	if (
		!value ||
		/[\x00-\x1f\x7f\\]/.test(value) ||
		value.split("/").some((p) => !p || p === "." || p === "..") ||
		path.isAbsolute(value)
	)
		refuse("Invalid dependency Git path.");
	return value;
}
const isLock = (file) => locks.has(path.posix.basename(file));
const relevant = (file) =>
	isLock(file) || declarations.has(path.posix.basename(file));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function inventory(workspace, revision) {
	const entries = utf8(
		git(workspace, ["ls-tree", "-rz", "--full-tree", revision]),
	)
		.split("\0")
		.filter(Boolean);
	const found = new Map();
	for (const entry of entries) {
		const separator = entry.indexOf("\t");
		const file = entry.slice(separator + 1);
		if (!relevant(file)) continue;
		location(file);
		const [mode, type, oid] = entry.slice(0, separator).split(" ");
		if (type !== "blob" || !["100644", "100755"].includes(mode))
			refuse("Dependency inputs must be regular tracked Git files.");
		if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid) || found.has(file))
			refuse("Invalid dependency Git inventory.");
		found.set(file, { path: file, oid, mode });
		if (found.size > 2048)
			refuse("Dependency source inventory exceeds its bound.");
	}
	return found;
}

// True when ancestor is an ancestor of descendant; any other Git answer refuses.
function ancestor(workspace, older, newer) {
	const result = spawnSync(
		"git",
		[
			"--no-optional-locks",
			"-c",
			"core.hooksPath=/dev/null",
			"merge-base",
			"--is-ancestor",
			older,
			newer,
		],
		{ cwd: workspace, timeout: 30000, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } },
	);
	if (result.error || ![0, 1].includes(result.status))
		refuse("Exact dependency Git inputs are unavailable.");
	return result.status === 0;
}

export function sources(workspace, revisions) {
	const { base, head, merge } = revisions;
	for (const revision of [base, head, merge]) {
		if (
			typeof revision !== "string" ||
			!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision)
		)
			refuse("Dependency comparison requires exact Git commit identities.");
		if (
			git(workspace, ["cat-file", "-t", revision], 128).toString().trim() !==
			"commit"
		)
			refuse("Dependency source is not a commit.");
	}
	const parents = git(
		workspace,
		["show", "--no-patch", "--format=%P", merge],
		1024,
	)
		.toString()
		.trim()
		.split(" ");
	if (parents.length !== 2 || parents[1] !== head)
		refuse("Dependency merge does not bind the exact PR head.");
	// GitHub recomputes the proposed merge on the base branch's current commit, while the event
	// keeps the base of the pull request's last push. The comparison uses the merge's own first
	// parent, which must be that event base or a commit the base branch moved forward to.
	const mergeBase = parents[0];
	if (mergeBase !== base && !ancestor(workspace, base, mergeBase))
		refuse("Dependency merge base is neither the PR base nor a later commit of it.");
	if (git(workspace, ["rev-parse", "HEAD"], 128).toString().trim() !== merge)
		refuse("Dependency checkout differs from the declared merge revision.");
	const old = inventory(workspace, mergeBase);
	const current = inventory(workspace, merge);
	const changed = [...new Set([...old.keys(), ...current.keys()])].some(
		(file) =>
			old.get(file)?.oid !== current.get(file)?.oid ||
			old.get(file)?.mode !== current.get(file)?.mode,
	);
	const renamed = new Map();
	if (changed) {
		const changes = utf8(
			git(workspace, [
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--name-status",
				"-z",
				"--find-renames=50%",
				mergeBase,
				merge,
			]),
		).split("\0");
		for (let i = 0; i < changes.length - 1; ) {
			const status = changes[i++];
			const from = changes[i++];
			if (status.startsWith("R") || status.startsWith("C")) {
				const to = changes[i++];
				if (status.startsWith("R") && isLock(from) && isLock(to))
					renamed.set(location(from), location(to));
			}
		}
	}
	return {
		revisions: { base, mergeBase, head, merge },
		changed,
		base: [...old.values()].filter((e) => isLock(e.path)),
		head: [...current.values()].filter((e) => isLock(e.path)),
		renames: renamed,
	};
}

export function materialize(workspace, entries, directory) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	let total = 0;
	return entries.map((entry) => {
		const size = Number(
			git(workspace, ["cat-file", "-s", entry.oid], 128).toString().trim(),
		);
		if (
			!Number.isSafeInteger(size) ||
			size < 0 ||
			size > 16 * 1024 * 1024 ||
			(total += size) > 128 * 1024 * 1024
		)
			refuse("Dependency source bytes exceed their bound.");
		const bytes = git(
			workspace,
			["cat-file", "blob", entry.oid],
			16 * 1024 * 1024 + 1,
		);
		if (bytes.length !== size)
			refuse("Dependency Git blob changed while reading.");
		const destination = path.join(directory, location(entry.path));
		mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
		writeFileSync(destination, bytes, { flag: "wx", mode: 0o400 });
		return { path: entry.path, blob: entry.oid, size, sha256: digest(bytes) };
	});
}
