import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { fetch, missing } from "../lib/change-objects.mjs";

const identity = {
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function run(cwd, args, env = {}) {
	return spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...identity, GIT_TERMINAL_PROMPT: "0", ...env },
	});
}

// A repository that serves partial clones, with a pull request of two commits beside a base
// that moved on, and a checkout of the proposed merge.
function fixture(body, { sparse = false, cloneArgs = ["--filter=blob:none"] } = {}) {
	const root = mkdtempSync(path.join(tmpdir(), "ci-change-objects-"));
	const origin = path.join(root, "origin");
	const checkout = path.join(root, "checkout");
	mkdirSync(origin);
	const git = (...args) => {
		const result = run(origin, args);
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	const commit = (files) => {
		for (const [file, content] of Object.entries(files))
			writeFileSync(path.join(origin, file), content);
		git("add", ".");
		git("-c", "commit.gpgsign=false", "commit", "-m", "fixture");
		return git("rev-parse", "HEAD");
	};
	try {
		git("init", "--initial-branch=dev");
		git("config", "uploadpack.allowFilter", "true");
		git("config", "uploadpack.allowAnySHA1InWant", "true");
		mkdirSync(path.join(origin, ".github/workflows"), { recursive: true });
		mkdirSync(path.join(origin, "retained"));
		mkdirSync(path.join(origin, "project"));
		const rootCommit = commit({
			"kept.txt": "kept\n",
			".betterleaks.toml": "[extend]\nuseDefault = true\n",
			"committed.toml": "subject_length = 72\n",
			"base.txt": "base 1\n",
			"change.txt": "change 1\n",
			".github/workflows/ci.yml": "name: Fixture\n",
			"retained/opaque.bin": "unchanged retained content\n",
			"project/package.json": '{"name":"fixture","version":"1.0.0"}\n',
		});
		git("checkout", "-b", "change");
		commit({ "change.txt": "change 2\n" });
		const head = commit({
			"change.txt": "change 3\n",
			"new.txt": "new\n",
			...(sparse ? { "project/package.json": '{"name":"fixture","version":"1.0.1"}\n' } : {}),
		});
		git("checkout", "dev");
		const base = commit({ "base.txt": "base 2\n" });
		git("merge", "--no-ff", "-m", "fixture merge", "change");
		const merge = git("rev-parse", "HEAD");
		const clone = run(root, [
			"clone",
			"--quiet",
			...cloneArgs,
			"--no-checkout",
			pathToFileURL(origin).href,
			checkout,
		]);
		assert.equal(clone.status, 0, clone.stderr);
		if (sparse) {
			const workflow = readFileSync(new URL("../.github/workflows/merge-stops.yml", import.meta.url), "utf8");
			const patterns = [...workflow.matchAll(/inputs\.sparse-checkout && '([^']+)'/g)].map((match) => match[1]);
			const selection = run(checkout, ["sparse-checkout", "set", "--no-cone", ...patterns]);
			assert.equal(selection.status, 0, selection.stderr);
		}
		const out = run(checkout, ["checkout", "--quiet", "--detach", merge]);
		assert.equal(out.status, 0, out.stderr);
		body({
			checkout,
			revisions: { root: rootCommit, base, head, merge },
			retained: git("rev-parse", `${merge}:retained/opaque.bin`),
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// What the stops run afterwards, with the network closed to Git.
function stops(checkout, { base, head, merge }) {
	const offline = { GIT_NO_LAZY_FETCH: "1" };
	return [
		run(checkout, ["log", "-p", "-m", `${base}..${head}`], offline),
		run(checkout, ["diff", "--find-renames=50%", `${merge}^1`, merge], offline),
	];
}

test("a checkout without contents gets what the merge stops read in one request", () => {
	fixture(({ checkout, revisions }) => {
		// The two earlier versions of the changed file are in no checked-out tree.
		for (const result of stops(checkout, revisions))
			assert.notEqual(result.status, 0);
		const objects = missing(checkout, revisions);
		assert.equal(objects.length, 2);
		fetch(checkout, objects);
		for (const result of stops(checkout, revisions))
			assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(missing(checkout, revisions), []);
		// Nothing is asked when nothing is missing.
		fetch(checkout, []);
	});
});

test("sparse merge stops leave unchanged payloads outside the worktree and object database", () => {
	fixture(({ checkout, retained, revisions }) => {
		const offline = { GIT_NO_LAZY_FETCH: "1" };
		const checkRetained = () => {
			assert.equal(existsSync(path.join(checkout, "retained")), false);
			assert.notEqual(run(checkout, ["cat-file", "-e", retained], offline).status, 0);
		};
		checkRetained();
		assert.equal(existsSync(path.join(checkout, ".github/workflows/ci.yml")), true);
		assert.equal(existsSync(path.join(checkout, "kept.txt")), false);
		assert.equal(existsSync(path.join(checkout, "committed.toml")), true);
		assert.equal(existsSync(path.join(checkout, ".betterleaks.toml")), true);
		const objects = missing(checkout, revisions);
		assert.equal(objects.length, 6);
		fetch(checkout, objects);
		for (const result of stops(checkout, revisions))
			assert.equal(result.status, 0, result.stderr);
		const manifest = run(checkout, ["show", `${revisions.merge}:project/package.json`], offline);
		assert.equal(manifest.status, 0, manifest.stderr);
		assert.equal(JSON.parse(manifest.stdout).version, "1.0.1");
		assert.equal(existsSync(path.join(checkout, "project")), false);
		assert.deepEqual(missing(checkout, revisions), []);
		checkRetained();
	}, { sparse: true });
});

test("completeTree skips fetching and preserves history on a full checkout", () => {
	fixture(({ checkout, revisions }) => {
		const offline = { GIT_NO_LAZY_FETCH: "1" };
		assert.equal(run(checkout, ["remote", "set-url", "origin", "file:///nonexistent"]).status, 0);
		fetch(checkout, [revisions.base, revisions.head], { completeTree: true });
		assert.equal(run(checkout, ["rev-parse", "--is-shallow-repository"]).stdout.trim(), "false");
		assert.equal(run(checkout, ["merge-base", "--is-ancestor", revisions.root, revisions.merge]).status, 0);
		assert.equal(run(checkout, ["show", `${revisions.base}:base.txt`], offline).stdout, "base 2\n");
	}, { cloneArgs: [] });
});

test("completeTree fetches missing blobs and trees without creating a shallow boundary", () => {
	for (const filter of ["--filter=blob:none", "--filter=tree:0"]) {
		fixture(({ checkout, revisions }) => {
			const offline = { GIT_NO_LAZY_FETCH: "1" };
			assert.notEqual(run(checkout, ["show", `${revisions.base}:change.txt`], offline).status, 0);
			fetch(checkout, [revisions.base, revisions.head], { completeTree: true });
			assert.equal(run(checkout, ["rev-parse", "--is-shallow-repository"]).stdout.trim(), "false");
			assert.equal(run(checkout, ["merge-base", "--is-ancestor", revisions.root, revisions.merge]).status, 0);
			assert.equal(run(checkout, ["show", `${revisions.base}:change.txt`], offline).stdout, "change 1\n");
			assert.equal(run(checkout, ["show", `${revisions.head}:change.txt`], offline).stdout, "change 3\n");
		}, { cloneArgs: [filter] });
	}
});

test("completeTree falls back to a depth-1 fetch when the commit is absent locally", () => {
	fixture(({ checkout, revisions }) => {
		const offline = { GIT_NO_LAZY_FETCH: "1" };
		assert.notEqual(run(checkout, ["cat-file", "-e", `${revisions.base}^{commit}`], offline).status, 0);
		fetch(checkout, [revisions.base], { completeTree: true });
		assert.equal(run(checkout, ["cat-file", "-e", `${revisions.base}^{commit}`], offline).status, 0);
		assert.equal(run(checkout, ["show", `${revisions.base}:base.txt`], offline).stdout, "base 2\n");
		assert.equal(run(checkout, ["show", `${revisions.base}:change.txt`], offline).stdout, "change 1\n");
	}, { cloneArgs: ["--depth=1", "--no-single-branch"] });
});

test("a commit identity that is not exact is refused", () => {
	fixture(({ checkout, revisions }) => {
		assert.throws(
			() => missing(checkout, { ...revisions, head: "change" }),
			/exact Git commit identities/,
		);
		assert.throws(
			() => fetch(checkout, ["--upload-pack=evil"], { completeTree: true }),
			/exact Git object identities/,
		);
		assert.throws(
			() => fetch(checkout, ["0".repeat(40)], { server: "http://example.invalid", token: "t" }),
			/HTTPS server/,
		);
	});
});
