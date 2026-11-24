import { pathToFileURL } from "node:url";
import { checkState, client, fallbackActor, isHostedFallbackRun } from "../lib/qualification.mjs";
import { ReleaseError } from "../lib/release.mjs";

const refuse = (message) => { throw new ReleaseError(message); };
const profiles = new Set(["linux-x64", "linux-arm64", "macos-arm64", "windows-x64"]);
const active = new Set(["queued", "pending", "requested", "waiting", "in_progress"]);

export async function replacePush(github, {repository, workflow, branch, sha, profile, pushId, actorId}) {
  if (!profiles.has(profile) || !Number.isSafeInteger(pushId) || pushId <= 0)
    refuse("Select a hosted runner profile and the exact push run ID.");
  const actor = fallbackActor(actorId);
  if (actor === null) refuse("The scheduler App actor ID is required.");

  const workflowPath = `.github/workflows/${workflow}`;
  const expected = {repository, workflowPath, branch, sha};
  const qualification = {fallbackActorId: actorId};
  const {run: newest, state} = await checkState(github, expected, qualification);
  const api = `/repos/${repository}`;
  const route = (id) => `${api}/actions/runs/${id}`;
  const matches = (run, id) => run?.id === id && run.path === workflowPath &&
    run.repository?.full_name === repository && run.head_repository?.full_name === repository &&
    run.head_branch === branch && run.head_sha === sha;

  const push = await github.json("GET", route(pushId));
  if (!matches(push, pushId) || push.event !== "push")
    refuse("The selected push run does not match the exact repository, workflow, branch and commit.");
  if (!newest || (newest.event === "push" && newest.id !== pushId) || newest.id < pushId)
    refuse("A different push run is now eligible for this commit.");

  let fallback = newest && isHostedFallbackRun(newest, actor) ? newest : null;
  if (!fallback) {
    if (!active.has(push.status)) refuse("The selected push run is no longer active.");
    const ref = await github.json("GET", `${api}/branches/${encodeURIComponent(branch)}`);
    if (ref?.commit?.sha !== sha) refuse("The branch has advanced past the selected commit.");
    const dispatched = await github.json("POST", `${api}/actions/workflows/${workflow}/dispatches`, {
      body: {ref: branch, inputs: {runner: "github", "runner-profile": profile}},
    });
    const id = dispatched?.workflow_run_id;
    if (!Number.isSafeInteger(id) || id <= pushId)
      refuse("The workflow dispatch did not return a newer run ID.");
    fallback = await github.json("GET", route(id), {optional: true});
    if (!fallback) refuse(`Workflow dispatch run ${id} is not visible; the push was left running.`);
    if (!matches(fallback, id) || !isHostedFallbackRun(fallback, actor)) {
      // A branch update can race the dispatch. Only its own new run may be cancelled here.
      if (fallback.id === id && fallback.repository?.full_name === repository &&
          fallback.path === workflowPath && isHostedFallbackRun(fallback, actor) && active.has(fallback.status))
        await (await github.request("POST", `${route(id)}/cancel`)).body?.cancel();
      refuse(`Workflow dispatch run ${id} did not match the qualified fallback; the push was left running.`);
    }
  }
  if (!active.has(fallback.status)) {
    const completed = fallback === newest ? {state, run: newest} : await checkState(github, expected, qualification);
    if (completed.state !== "qualified" || completed.run?.id !== fallback.id)
      refuse(`Fallback run ${fallback.id} did not pass the exact full check.`);
  }
  if (active.has(push.status)) {
    const cancelled = await github.request("POST", `${route(pushId)}/cancel`);
    await cancelled.body?.cancel();
    if (cancelled.status !== 202) {
      const current = await github.json("GET", route(pushId));
      if (current?.status !== "completed") refuse(`GitHub did not accept cancellation for push run ${pushId}.`);
    }
  }
  return {push_run_id: pushId, fallback_run_id: fallback.id};
}

async function main() {
  const [repository, workflow, branch, sha, profile, pushRun] = process.argv.slice(2);
  if (!process.env.GH_TOKEN) refuse("Provide the scheduler App installation token as GH_TOKEN.");
  const github = client(process.env.GH_TOKEN, undefined, {apiVersion: "2026-03-10"});
  const result = await replacePush(github, {
    repository, workflow, branch, sha, profile, pushId: Number(pushRun),
    actorId: process.env.NDDEV_BRANCH_FALLBACK_ACTOR_ID || "",
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error instanceof ReleaseError ? error.message : "Hosted fallback did not complete.");
    process.exitCode = 1;
  });
