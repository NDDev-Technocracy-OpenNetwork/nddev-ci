import { ReleaseError } from "./release.mjs";
import { checkWorkflowStates, qualificationWorkflows } from "./qualification.mjs";
import { dailyPublication } from "./release-cadence.mjs";

const refuse = (message) => { throw new ReleaseError(message); };
const branchName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// A day's commits stay far below this; more means promotion stopped and needs a look.
export const maxCommits = 250;

// Chooses the commit the target branch moves forward to: the newest commit of the source branch,
// ahead of the target, whose newest full check on a push passed. A newer commit whose check failed
// or still runs waits for the next promotion; an older green run never stands in for it.
export async function selectPromotion(github, {repository, workflowPath, requiredWorkflows = "", source = "dev", target = "main"}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      ![source, target].every((name) => branchName.test(name ?? "") && !name.includes("..")) || source === target)
    refuse("Promotion requires an exact repository and two different branch names.");
  const workflows = qualificationWorkflows(workflowPath, requiredWorkflows);
  const compare = await github.json("GET",
    `/repos/${repository}/compare/${encodeURIComponent(target)}...${encodeURIComponent(source)}?per_page=${maxCommits}`);
  if (!compare || !Number.isSafeInteger(compare.ahead_by) || !Number.isSafeInteger(compare.behind_by) ||
      !Number.isSafeInteger(compare.total_commits) || !Array.isArray(compare.commits))
    refuse("The branch comparison is malformed.");
  if (compare.behind_by > 0)
    refuse(`${target} has commits that ${source} lacks; promotion only moves ${target} forward.`);
  if (compare.ahead_by === 0) return {state: "current"};
  if (compare.total_commits > maxCommits || compare.commits.length !== compare.total_commits)
    refuse(`${source} is ${compare.total_commits} commits ahead of ${target}; promote by hand after a look.`);
  const skipped = [];
  for (const commit of [...compare.commits].reverse()) {
    if (!/^[0-9a-f]{40}$/.test(commit?.sha ?? "")) refuse("The branch comparison names a malformed commit.");
    const selections = await checkWorkflowStates(github, {repository, sha: commit.sha, branch: source, event: "push"}, workflows);
    const blocked = selections.findIndex((selection) => selection.state !== "qualified");
    if (blocked < 0)
      return {state: "ready", sha: commit.sha, run_id: selections[0].run.id, skipped};
    const selection = selections[blocked];
    if (selection.state !== "missing" || workflows.length > 1)
      skipped.push({sha: commit.sha, state: selection.state, reason: `${workflows[blocked]}: ${selection.reason}`});
  }
  return {state: "unchecked", skipped};
}

// Resume an unfinished main publication before choosing a later source. The promotion job is
// serial, and the publisher independently enforces the date while holding its own serial lock.
export async function selectDailyPromotion(github, options, now = new Date()) {
  const {repository, target = "main"} = options;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      !branchName.test(target) || target.includes("..")) refuse("Daily promotion requires an exact target.");
  const ref = await github.json("GET", `/repos/${repository}/git/ref/heads/${encodeURIComponent(target)}`);
  if (ref?.ref !== `refs/heads/${target}` || ref?.object?.type !== "commit" || !/^[0-9a-f]{40}$/.test(ref.object.sha ?? ""))
    refuse("The daily promotion target has no exact source.");
  const cadence = await dailyPublication(github, {repository, sha: ref.object.sha, currentSource: true, now});
  if (cadence.state === "held") return {state: "held"};
  if (cadence.latestSource && cadence.latestSource !== ref.object.sha)
    return {state: "release_pending", sha: ref.object.sha};
  return selectPromotion(github, options);
}
