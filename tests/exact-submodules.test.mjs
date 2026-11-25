import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const action = fileURLToPath(new URL("../actions/prepare/exact-submodules.mjs", import.meta.url));
const env = {
	...process.env,
	GIT_ALLOW_PROTOCOL: "file",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function run(program, args, cwd) {
	const output = spawnSync(program, args, { cwd, env, encoding: "utf8" });
	assert.ifError(output.error);
	assert.equal(output.status, 0, output.stderr);
	return output.stdout.trim();
}

function git(cwd, ...args) {
	return run("git", args, cwd);
}

test("prepare takes an exact stale pin and preserves a populated submodule on repeated setup", () => {
	const work = mkdtempSync(join(tmpdir(), "exact-submodules-"));
	try {
		const module = join(work, "module");
		git(work, "init", "-q", "-b", "dev", module);
		writeFileSync(join(module, "data"), "pinned\n");
		git(module, "add", ".");
		git(module, "commit", "-qm", "First");
		const pin = git(module, "rev-parse", "HEAD");
		const origin = pathToFileURL(module).href;
		const source = join(work, "source");
		const path = "modules/one module";
		git(work, "init", "-q", "-b", "dev", source);
		git(source, "submodule", "add", "-q", "--name", "one", "--", origin, path);
		git(source, "commit", "-qm", "Pin");
		writeFileSync(join(module, "data"), "newer\n");
		git(module, "commit", "-qam", "New tip");

		const checkout = join(work, "checkout");
		git(work, "clone", "-q", "--no-recurse-submodules", pathToFileURL(source).href, checkout);
		const installed = join(checkout, path);
		const help = spawnSync("git", ["clone", "-h"], { encoding: "utf8" });
		const expected = /--(?:\[no-\])?revision\b/.test(help.stdout + help.stderr) ? "exact" : "standard";
		delete env.GITHUB_WORKSPACE;
		assert.match(run(process.execPath, [action], checkout), new RegExp("^Submodule setup: " + expected + " "));
		assert.equal(git(installed, "rev-parse", "HEAD"), pin);
		assert.equal(git(installed, "config", "--local", "--get", "remote.origin.url"), origin);
		assert.equal(git(checkout, "status", "--porcelain"), "");
		if (expected === "exact") assert.equal(git(installed, "for-each-ref", "refs/remotes"), "");

		writeFileSync(join(installed, "untracked"), "local work\n");
		assert.match(run(process.execPath, [action], checkout), /^Submodule setup: standard /);
		assert.equal(git(installed, "rev-parse", "HEAD"), pin);
		assert.equal(git(installed, "status", "--porcelain"), "?? untracked");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
