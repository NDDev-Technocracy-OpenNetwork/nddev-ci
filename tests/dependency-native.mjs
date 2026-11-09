// The vulnerable dependencies below are inert scanner data. Nothing installs or runs them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(run) {
	const root = mkdtempSync(path.join(tmpdir(), "dependency-native-"));
	const workspace = path.join(root, "checkout");
	const temporary = path.join(root, "runner temporary");
	mkdirSync(workspace);
	mkdirSync(temporary);
	const environment = {
		...process.env,
		GIT_AUTHOR_NAME: "fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.invalid",
	};
	const git = (...args) => {
		const result = spawnSync("git", args, {
			cwd: workspace,
			encoding: "utf8",
			env: environment,
		});
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	const write = (file, value) => {
		const out = path.join(workspace, file);
		mkdirSync(path.dirname(out), { recursive: true });
		writeFileSync(out, value);
	};
	const commit = () => {
		git("add", ".");
		git("-c", "commit.gpgsign=false", "commit", "-m", "fixture");
		return git("rev-parse", "HEAD");
	};
	const lock = (folder, transitive = false) =>
		write(
			`${folder}package-lock.json`,
			JSON.stringify({
				name: "inert-native-data",
				version: "1.0.0",
				lockfileVersion: 3,
				packages: {
					"": {
						name: "inert-native-data",
						version: "1.0.0",
						dependencies: transitive
							? { "is-number": "7.0.0" }
							: { vm2: "3.9.10" },
					},
					...(transitive
						? {
								"node_modules/is-number": {
									name: "is-number",
									version: "7.0.0",
									resolved:
										"https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
									dependencies: { vm2: "3.9.10" },
								},
							}
						: {}),
					[transitive
						? "node_modules/is-number/node_modules/vm2"
						: "node_modules/vm2"]: {
						name: "vm2",
						version: "3.9.10",
						resolved: "https://registry.npmjs.org/vm2/-/vm2-3.9.10.tgz",
					},
				},
			}),
		);
	const compare = (base, head) => {
		const merge = git(
			"commit-tree",
			`${head}^{tree}`,
			"-p",
			base,
			"-p",
			head,
			"-m",
			"fixture merge",
		);
		git("checkout", "--detach", merge);
		const result = spawnSync(
			process.execPath,
			[
				new URL("../actions/dependency-guard/run.mjs", import.meta.url)
					.pathname,
			],
			{
				env: {
					...environment,
					GITHUB_WORKSPACE: workspace,
					RUNNER_TEMP: temporary,
					GITHUB_STEP_SUMMARY: "",
					INPUT_BASE: base,
					INPUT_HEAD: head,
					INPUT_MERGE: merge,
					"INPUT_GITHUB-TOKEN": process.env.GH_TOKEN ?? "",
				},
				encoding: "utf8",
				timeout: 600000,
				maxBuffer: 16 * 1024 * 1024,
			},
		);
		assert.ifError(result.error);
		assert.deepEqual(
			readdirSync(temporary),
			[],
			"the action must remove all of its owned scan and tool bytes",
		);
		return result;
	};
	try {
		git("init", "--initial-branch=fixture");
		run({ root, workspace, write, commit, lock, compare });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test(
	"the real action blocks a new transitive fixed critical finding and diagnoses existing ones",
	{ timeout: 600000 },
	() =>
		fixture(({ workspace, write, commit, lock, compare }) => {
			lock("");
			const base = commit();
			lock("new project/", true);
			write(
				"osv-scanner.toml",
				'[[PackageOverrides]]\nname="vm2"\necosystem="npm"\nignore=true\n',
			);
			write(
				"new project/package.json",
				JSON.stringify({ scripts: { install: "touch MUST_NOT_EXECUTE" } }),
			);
			const head = commit();
			const result = compare(base, head);
			assert.equal(result.status, 1, result.stderr);
			assert.match(result.stderr, /critical dependency finding/);
			const receipt = result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.find((entry) => entry.schema_version === 1);
			assert(receipt.introduced.length > 0);
			assert(
				receipt.introduced.every(
					(finding) =>
						finding.source === "new project/package-lock.json" &&
						finding.name === "vm2" &&
						finding.severity >= 9 &&
						finding.fixed.length,
				),
			);
			assert(receipt.diagnostics.preexisting > 0);
			assert.equal(receipt.basePackages, 1);
			assert.equal(receipt.headPackages, 3);
			assert(
				receipt.databases.some(
					(entry) =>
						entry.path.endsWith("npm/all.zip") &&
						entry.size > 0 &&
						/^[a-f0-9]{64}$/.test(entry.sha256),
				),
			);
			assert.equal(receipt.scanner.version, "2.7.0");
			assert.equal(
				existsSync(path.join(workspace, "new project/MUST_NOT_EXECUTE")),
				false,
			);
		}),
);
test(
	"a partly malformed scan fails even when another lockfile is valid",
	{ timeout: 600000 },
	() =>
		fixture(({ write, commit, lock, compare }) => {
			lock("");
			const base = commit();
			write("malformed/package-lock.json", "{broken");
			const head = commit();
			const result = compare(base, head);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /no clean comparison was produced/);
			assert.doesNotMatch(result.stderr, /change introduces/);
		}),
);
