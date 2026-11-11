import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fetch, missing } from "../../lib/change-objects.mjs";

export function main(environment = process.env) {
	const workspace = realpathSync(environment.GITHUB_WORKSPACE);
	const objects = missing(workspace, {
		base: environment.INPUT_BASE,
		head: environment.INPUT_HEAD,
		merge: environment.INPUT_MERGE,
	});
	fetch(workspace, objects, {
		server: environment.GITHUB_SERVER_URL,
		token: environment["INPUT_GITHUB-TOKEN"],
	});
	const receipt = { schema_version: 1, fetched: objects.length };
	console.log(JSON.stringify(receipt));
	return receipt;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	try {
		main();
	} catch (error) {
		console.error(
			`::error::${String(error.message).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`,
		);
		process.exitCode = 1;
	}
}
