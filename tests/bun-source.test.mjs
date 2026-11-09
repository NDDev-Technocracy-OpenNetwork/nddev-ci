import assert from "node:assert/strict";
import test from "node:test";
import { asset } from "../actions/hosted-sdk/bun.mjs";

function release() {
	return {
		tag_name: "bun-v1.4.4",
		draft: false,
		prerelease: false,
		assets: [
			"linux-x64",
			"linux-x64-baseline",
			"linux-aarch64",
			"darwin-x64",
			"darwin-aarch64",
			"windows-x64",
			"windows-aarch64",
		].map((target, index) => ({
			id: index + 1,
			name: `bun-${target}.zip`,
			size: 1024,
			digest: `sha256:${"a".repeat(64)}`,
		})),
	};
}
test("Bun selection retains native architecture and an explicit compatible x64 CPU target", () => {
	for (const [os, arch, avx2, file] of [
		["linux", "x64", true, "bun-linux-x64.zip"],
		["linux", "x64", false, "bun-linux-x64-baseline.zip"],
		["darwin", "arm64", false, "bun-darwin-aarch64.zip"],
		["darwin", "x64", true, "bun-darwin-x64.zip"],
		["win32", "x64", true, "bun-windows-x64.zip"],
		["win32", "arm64", true, "bun-windows-aarch64.zip"],
	]) {
		const value = asset(release(), "1.4.4", os, arch, avx2);
		assert.equal(value.name, file);
		assert.equal(value.repository, "oven-sh/bun");
		assert.equal(value.tag, "bun-v1.4.4");
		assert.match(value.published_sha256, /^[a-f0-9]{64}$/);
	}
});
test("a different, draft, incomplete or ambiguous source fails without another provider or target", () => {
	const cases = [
		null,
		{ ...release(), tag_name: "bun-v1.4.3" },
		{ ...release(), draft: true },
		{ ...release(), prerelease: true },
		{ ...release(), assets: [] },
	];
	const duplicate = release();
	duplicate.assets.push(duplicate.assets[4]);
	cases.push(duplicate);
	for (const value of [
		{ digest: undefined },
		{ digest: "sha256:invalid" },
		{ size: 0 },
		{ id: 0 },
	]) {
		const incomplete = release();
		Object.assign(incomplete.assets[4], value);
		cases.push(incomplete);
	}
	for (const value of cases)
		assert.throws(() => asset(value, "1.4.4", "darwin", "arm64"));
	assert.throws(() => asset(release(), "1.4.4", "freebsd", "x64"));
	assert.throws(() => asset(release(), "1.4.4", "darwin", "ia32"));
});
