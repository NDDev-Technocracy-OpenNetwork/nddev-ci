import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
delete env.GITHUB_WORKSPACE;

function run(program, args, cwd) {
	const output = spawnSync(program, args, { cwd, env, encoding: "utf8" });
	assert.ifError(output.error);
	assert.equal(output.status, 0, output.stderr);
	return output.stdout.trim();
}

function git(cwd, ...args) {
	return run("git", args, cwd);
}

function fixture(t, exclude) {
	const work = mkdtempSync(join(tmpdir(), "exact-submodules-"));
	t.after(() => rmSync(work, { recursive: true, force: true }));

	const module = join(work, "module");
	git(work, "init", "-q", "-b", "dev", module);
	git(module, "config", "uploadpack.allowFilter", "true");
	git(module, "config", "uploadpack.allowAnySHA1InWant", "true");
	writeFileSync(join(module, "data"), "pinned\n");
	mkdirSync(join(module, "publication/export"), { recursive: true });
	writeFileSync(join(module, "publication/export/banner.png"), "store-only object\n");
	git(module, "add", ".");
	git(module, "commit", "-qm", "First");
	const pin = git(module, "rev-parse", "HEAD");
	const omitted = git(module, "rev-parse", pin + ":publication/export/banner.png");
	const origin = pathToFileURL(module).href;
	const source = join(work, "source");
	const path = "modules/one module";
	git(work, "init", "-q", "-b", "dev", source);
	git(source, "submodule", "add", "-q", "--name", "one", "--", origin, path);
	if (exclude) git(source, "config", "--file", ".gitmodules", "submodule.one.ciExclude", exclude);
	git(source, "add", ".gitmodules");
	git(source, "commit", "-qm", "Pin");
	writeFileSync(join(module, "data"), "newer\n");
	git(module, "commit", "-qam", "New tip");

	const checkout = join(work, "checkout");
	git(work, "clone", "-q", "--no-recurse-submodules", pathToFileURL(source).href, checkout);
	const installed = join(checkout, path);
	const help = spawnSync("git", ["clone", "-h"], { encoding: "utf8" });
	const expected = /--(?:\[no-\])?revision\b/.test(help.stdout + help.stderr) ? "exact" : "standard";
	return { checkout, installed, pin, origin, expected, omitted };
}

test("prepare takes an exact stale pin and preserves a populated submodule on repeated setup", (t) => {
	const { checkout, installed, pin, origin, expected } = fixture(t);
	assert.match(run(process.execPath, [action], checkout), new RegExp("^Submodule setup: " + expected + " "));
	assert.equal(git(installed, "rev-parse", "HEAD"), pin);
	assert.equal(git(installed, "config", "--local", "--get", "remote.origin.url"), origin);
	assert.equal(git(checkout, "status", "--porcelain"), "");
	if (expected === "exact") assert.equal(git(installed, "for-each-ref", "refs/remotes"), "");

	writeFileSync(join(installed, "untracked"), "local work\n");
	assert.match(run(process.execPath, [action], checkout), /^Submodule setup: standard /);
	assert.equal(git(installed, "rev-parse", "HEAD"), pin);
	assert.equal(git(installed, "status", "--porcelain"), "?? untracked");
});

test("a declared CI directory stays in the pinned tree without fetching its blob", (t) => {
	const { checkout, installed, pin, origin, expected, omitted } = fixture(t, "publication/export");
	assert.match(run(process.execPath, [action], checkout), new RegExp("^Submodule setup: " + expected + " "));
	assert.equal(git(installed, "rev-parse", "HEAD"), pin);
	assert.equal(git(installed, "config", "--local", "--get", "remote.origin.url"), origin);
	assert.equal(git(checkout, "status", "--porcelain"), "");
	assert.ok(existsSync(join(installed, "data")));
	assert.equal(git(installed, "rev-parse", "HEAD:publication/export/banner.png"), omitted);
	const asset = join(installed, "publication/export/banner.png");
	if (expected === "exact") {
		assert.equal(existsSync(asset), false);
		const unfetched = spawnSync("git", ["cat-file", "-e", omitted], {
			cwd: installed, env: { ...env, GIT_NO_LAZY_FETCH: "1" }, encoding: "utf8",
		});
		assert.ifError(unfetched.error);
		assert.notEqual(unfetched.status, 0);
		git(checkout, "submodule", "update", "--init", "--depth=1", "--quiet");
		assert.equal(existsSync(asset), false);
	} else {
		assert.ok(existsSync(asset));
	}
});
