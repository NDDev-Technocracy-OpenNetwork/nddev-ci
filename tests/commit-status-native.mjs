import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { client } from "../lib/qualification.mjs";
import { requireStatus } from "../lib/commit-status.mjs";

const {GITHUB_TOKEN, GITHUB_API_URL, GITHUB_REPOSITORY, SOURCE_COMMIT, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_OUTPUT, FIXTURE_RECEIPT} = process.env;
assert.ok(GITHUB_TOKEN && GITHUB_OUTPUT, "A job-scoped fixture token and output file are required.");
assert.match(SOURCE_COMMIT ?? "", /^[a-f0-9]{40}$/);
assert.match(GITHUB_RUN_ID ?? "", /^\d+$/); assert.match(GITHUB_RUN_ATTEMPT ?? "", /^\d+$/);
const mode = process.argv[2];
assert.ok(["publish", "observe"].includes(mode), "Select publish or observe.");
const github = client(GITHUB_TOKEN, GITHUB_API_URL);
const actor = await github.json("GET", "/users/github-actions%5Bbot%5D");
assert.ok(Number.isSafeInteger(actor.id) && actor.id > 0);
const context = `fixture/source-version/${GITHUB_RUN_ID}/${GITHUB_RUN_ATTEMPT}`;
const expected = {repository: GITHUB_REPOSITORY, sha: SOURCE_COMMIT, context, creator: actor.id, maximumStatuses: 1000};
const states = ["pending", "failure", "error", "success"];
const named = (state) => state === "success" ? context : `${context}/${state}`;
const write = (state, target = context) => github.json("POST", `/repos/${GITHUB_REPOSITORY}/statuses/${SOURCE_COMMIT}`,
  {body: {state, context: target, description: "Isolated commit-status qualification fixture"}});
try {
  if (mode === "publish") {
    const statuses = [];
    for (const state of states) {
      const actual = await write(state, named(state));
      assert.ok(Number.isSafeInteger(actual.id) && actual.id > 0);
      assert.equal(actual.state, state); assert.equal(actual.context, named(state));
      assert.equal(actual.creator?.id, actor.id);
      statuses.push({state, context: actual.context, id: actual.id});
    }
    appendFileSync(GITHUB_OUTPUT, `receipt=${JSON.stringify({source: SOURCE_COMMIT, creator: actor.id, statuses})}\n`);
  } else {
    const receipt = JSON.parse(FIXTURE_RECEIPT ?? "null");
    assert.equal(receipt?.source, SOURCE_COMMIT); assert.equal(receipt?.creator, actor.id);
    assert.equal(receipt?.statuses?.length, states.length);
    const ids = new Set();
    for (const [index, state] of states.entries()) {
      const published = receipt.statuses[index];
      assert.equal(published.state, state); assert.equal(published.context, named(state));
      assert.ok(Number.isSafeInteger(published.id) && published.id > 0 && !ids.has(published.id)); ids.add(published.id);
      let observed;
      const reader = {json: async (...args) => {
        const rows = await github.json(...args);
        const row = rows.find((entry) => entry.context === published.context);
        if (row) observed = {id: row.id, state: row.state};
        return rows;
      }};
      if (state === "success") {
        const actual = await requireStatus(reader, expected);
        assert.equal(actual.sha, SOURCE_COMMIT); assert.equal(actual.statusId, published.id);
      } else {
        await assert.rejects(requireStatus(reader, {...expected, context: published.context}), new RegExp(`status is ${state}`));
      }
      assert.deepEqual(observed, {id: published.id, state});
    }
    await assert.rejects(requireStatus(github, {...expected, creator: actor.id + 1}), /configured creator/);
    await assert.rejects(requireStatus(github, {...expected, context: `${context}/absent`}), /missing/);
    // Fixture negatives have been observed; leave no standing failed fixture statuses.
    for (const state of states.slice(0, -1)) await write("success", named(state));
    appendFileSync(GITHUB_OUTPUT, `context=${context}\ncreator=${actor.id}\n`);
    console.log(JSON.stringify({source: SOURCE_COMMIT, context, creator: actor.id, state: "ready",
      negativeStates: states.slice(0, -1), exactPublishedIdsObserved: true, wrongCreatorRefused: true, absentRefused: true}));
  }
} catch (error) {
  try { await write("error"); } catch { /* The original fixture failure remains authoritative. */ }
  throw error;
}
