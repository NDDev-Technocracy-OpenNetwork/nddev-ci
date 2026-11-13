import { ReleaseError } from "./release.mjs";
import { checkState } from "./qualification.mjs";

const refuse = (message) => { throw new ReleaseError(message); };
const branchName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// A day's commits stay far below this; more means promotion stopped and needs a look.
export const maxCommits = 250;

// Chooses the commit the target branch moves forward to: the newest commit of the source branch,
// ahead of the target, whose newest full check on a push passed. A newer commit whose check failed
// or still runs waits for the next promotion; an older green run never stands in for it.
export async function selectPromotion(github, {repository, workflowPath, source = "dev", target = "main"}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      ![source, target].every((name) => branchName.test(name ?? "") && !name.includes("..")) || source === target)
    refuse("Promotion requires an exact repository and two different branch names.");
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
    const selection = await checkState(github, {repository, sha: commit.sha, workflowPath, branch: source, event: "push"});
    if (selection.state === "qualified")
      return {state: "ready", sha: commit.sha, run_id: selection.run.id, skipped};
    if (selection.state !== "missing") skipped.push({sha: commit.sha, state: selection.state, reason: selection.reason});
  }
  return {state: "unchecked", skipped};
}
