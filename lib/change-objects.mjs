// The file contents the merge stops read, for a checkout that holds the history without them.
//
// A checkout made with `filter: blob:none` keeps every commit and tree and only the files of the
// checked-out commit. The stops read more: both sides of every change the pull request's commits
// make, and both sides of what the proposed merge changes on its base. This module names those
// contents from the trees alone and asks the repository for the missing ones in one request, so
// no later step needs the network or a credential.
import { spawnSync } from "node:child_process";

export class ChangeObjectsError extends Error {}

const limit = 256 * 1024 * 1024;
const identity = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function git(workspace, args, options = {}) {
	const result = spawnSync(
		"git",
		["--no-optional-locks", "-c", "core.hooksPath=/dev/null", ...args],
		{
			cwd: workspace,
			encoding: "utf8",
			maxBuffer: limit,
			timeout: options.timeout ?? 60000,
			input: options.input,
			env: {
				...process.env,
				GIT_NO_REPLACE_OBJECTS: "1",
				GIT_TERMINAL_PROMPT: "0",
				...options.env,
			},
		},
	);
	if (result.error || result.status !== 0)
		throw new ChangeObjectsError(
			options.refusal ?? "The change's Git objects are unavailable.",
		);
	return result.stdout;
}

// The blob identities on both sides of every raw diff line, gitlinks and absent sides left out.
function sides(raw) {
	const found = new Set();
	for (const line of raw.split("\n")) {
		if (!line.startsWith(":")) continue;
		const [oldMode, newMode, oldId, newId] = line.slice(1).split(/[ \t]/);
		if (oldMode !== "160000" && !/^0+$/.test(oldId)) found.add(oldId);
		if (newMode !== "160000" && !/^0+$/.test(newId)) found.add(newId);
	}
	return found;
}

// The contents the stops read that the checkout does not hold.
export function missing(workspace, { base, head, merge }) {
	for (const revision of [base, head, merge])
		if (typeof revision !== "string" || !identity.test(revision))
			throw new ChangeObjectsError(
				"The change's objects need exact Git commit identities.",
			);
	const wanted = new Set([
		// Every commit the pull request brings, against each of its parents.
		...sides(
			git(workspace, [
				"log",
				"--raw",
				"--no-abbrev",
				"-m",
				"--no-renames",
				"--format=",
				`${base}..${head}`,
			]),
		),
		// The proposed merge against the base commit it was made on.
		...sides(
			git(workspace, [
				"diff",
				"--raw",
				"--no-abbrev",
				"--no-renames",
				`${merge}^1`,
				merge,
			]),
		),
	]);
	if (!wanted.size) return [];
	const answers = git(workspace, ["cat-file", "--batch-check"], {
		input: `${[...wanted].join("\n")}\n`,
		// The question must not fetch one object at a time.
		env: { GIT_NO_LAZY_FETCH: "1" },
	});
	return answers
		.split("\n")
		.filter((line) => line.endsWith(" missing"))
		.map((line) => line.split(" ")[0]);
}

// One request for the named contents. The token travels in the environment of this one command.
export function fetch(workspace, objects, { server, token } = {}) {
	if (!objects.length) return;
	const env = {};
	if (token) {
		const origin = new URL(server);
		if (origin.protocol !== "https:" || origin.username || origin.password)
			throw new ChangeObjectsError(
				"The change's objects need an HTTPS server without credentials.",
			);
		env.GIT_CONFIG_COUNT = "1";
		env.GIT_CONFIG_KEY_0 = `http.${origin.origin}/.extraheader`;
		env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
	}
	git(
		workspace,
		[
			"-c",
			"fetch.negotiationAlgorithm=noop",
			"fetch",
			"--quiet",
			"--no-tags",
			"--no-write-fetch-head",
			"--recurse-submodules=no",
			"--filter=blob:none",
			"--stdin",
			"origin",
		],
		{
			input: `${objects.join("\n")}\n`,
			env,
			timeout: 300000,
			refusal: "The repository did not provide the change's file contents.",
		},
	);
}
