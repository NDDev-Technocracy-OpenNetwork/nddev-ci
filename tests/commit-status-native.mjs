import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { client } from "../lib/qualification.mjs";
import { requireStatus } from "../lib/commit-status.mjs";

const {GITHUB_TOKEN, GITHUB_API_URL, GITHUB_REPOSITORY, SOURCE_COMMIT, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_OUTPUT} = process.env;
assert.ok(GITHUB_TOKEN && GITHUB_OUTPUT, "A job-scoped fixture token and output file are required.");
assert.match(SOURCE_COMMIT ?? "", /^[a-f0-9]{40}$/);
assert.match(GITHUB_RUN_ID ?? "", /^\d+$/); assert.match(GITHUB_RUN_ATTEMPT ?? "", /^\d+$/);
const github = client(GITHUB_TOKEN, GITHUB_API_URL);
const actor = await github.json("GET", "/users/github-actions%5Bbot%5D");
assert.ok(Number.isSafeInteger(actor.id) && actor.id > 0);
const context = `fixture/source-version/${GITHUB_RUN_ID}/${GITHUB_RUN_ATTEMPT}`;
const expected = {repository: GITHUB_REPOSITORY, sha: SOURCE_COMMIT, context, creator: actor.id, maximumStatuses: 1000};
const write = (state) => github.json("POST", `/repos/${GITHUB_REPOSITORY}/statuses/${SOURCE_COMMIT}`,
  {body: {state, context, description: "Isolated commit-status qualification fixture"}});
try {
  for (const state of ["pending", "failure", "error"]) {
    await write(state);
    await assert.rejects(requireStatus(github, expected), new RegExp(`status is ${state}`));
  }
  await write("success");
  const actual = await requireStatus(github, expected);
  assert.equal(actual.sha, SOURCE_COMMIT);
  await assert.rejects(requireStatus(github, {...expected, creator: actor.id + 1}), /configured creator/);
  await assert.rejects(requireStatus(github, {...expected, context: `${context}/absent`}), /missing/);
  appendFileSync(GITHUB_OUTPUT, `context=${context}\ncreator=${actor.id}\n`);
  console.log(JSON.stringify({source: SOURCE_COMMIT, context, creator: actor.id, state: actual.state,
    negativeStates: ["pending", "failure", "error"], wrongCreatorRefused: true, absentRefused: true}));
} catch (error) {
  try { await write("error"); } catch { /* The original fixture failure remains authoritative. */ }
  throw error;
}
