import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// that moved on, and a checkout of the proposed merge that holds the history without contents.
function fixture(body) {
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
		commit({ "kept.txt": "kept\n", "base.txt": "base 1\n", "change.txt": "change 1\n" });
		git("checkout", "-b", "change");
		commit({ "change.txt": "change 2\n" });
		const head = commit({ "change.txt": "change 3\n", "new.txt": "new\n" });
		git("checkout", "dev");
		const base = commit({ "base.txt": "base 2\n" });
		git("merge", "--no-ff", "-m", "fixture merge", "change");
		const merge = git("rev-parse", "HEAD");
		const clone = run(root, [
			"clone",
			"--quiet",
			"--filter=blob:none",
			"--no-checkout",
			pathToFileURL(origin).href,
			checkout,
		]);
		assert.equal(clone.status, 0, clone.stderr);
		const out = run(checkout, ["checkout", "--quiet", "--detach", merge]);
		assert.equal(out.status, 0, out.stderr);
		body({ checkout, revisions: { base, head, merge } });
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

test("a commit identity that is not exact is refused", () => {
	fixture(({ checkout, revisions }) => {
		assert.throws(
			() => missing(checkout, { ...revisions, head: "change" }),
			/exact Git commit identities/,
		);
		assert.throws(
			() => fetch(checkout, ["0".repeat(40)], { server: "http://example.invalid", token: "t" }),
			/HTTPS server/,
		);
	});
});
