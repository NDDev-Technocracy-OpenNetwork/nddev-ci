import { appendFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sources, materialize } from "../../lib/dependency-source.mjs";
import { prepareScanner, scanSources } from "../../lib/dependency-scan.mjs";

export async function main(environment = process.env) {
	const workspace = realpathSync(environment.GITHUB_WORKSPACE);
	const input = sources(workspace, {
		base: environment.INPUT_BASE,
		head: environment.INPUT_HEAD,
		merge: environment.INPUT_MERGE,
	});
	if (!input.changed || (!input.base.length && !input.head.length)) {
		const receipt = {
			schema_version: 1,
			revisions: input.revisions,
			status: "skipped",
			reason: input.changed
				? "no-supported-tracked-lockfiles"
				: "dependency-inputs-unchanged",
			scope: "tracked-source-lockfiles",
		};
		console.log(JSON.stringify(receipt));
		return receipt;
	}
	const directory = mkdtempSync(
		path.join(realpathSync(environment.RUNNER_TEMP), "nddev-dependencies-"),
	);
	try {
		const base = materialize(
			workspace,
			input.base,
			path.join(directory, "inputs", "base"),
		);
		const head = materialize(
			workspace,
			input.head,
			path.join(directory, "inputs", "head"),
		);
		const binary = await prepareScanner(directory, {
			...environment,
			GH_TOKEN: environment["INPUT_GITHUB-TOKEN"],
		});
		const result = await scanSources(binary, directory, input, environment);
		const receipt = {
			schema_version: 1,
			revisions: input.revisions,
			scope: "tracked-source-lockfiles",
			inputs: { base, head },
			...result,
		};
		const visible = {
			...receipt,
			introduced: result.introduced.slice(0, 50),
			omittedIntroduced: Math.max(0, result.introduced.length - 50),
		};
		const rendered = JSON.stringify(visible)
			.replace(/</g, "\\u003c")
			.replace(/`/g, "\\u0060");
		console.log(rendered);
		if (environment.GITHUB_STEP_SUMMARY)
			appendFileSync(
				environment.GITHUB_STEP_SUMMARY,
				`## Dependency comparison\n\nNew fixed critical findings: ${result.introduced.length}.\n\n\`\`\`json\n${rendered}\n\`\`\`\n`,
			);
		if (result.introduced.length)
			throw new Error(
				`The change introduces ${result.introduced.length} critical dependency finding(s) with a known fix.`,
			);
		return receipt;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	try {
		await main();
	} catch (error) {
		console.error(
			`::error::${String(error.message).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`,
		);
		process.exitCode = 1;
	}
}
