import { ReleaseError } from "./release.mjs";
import { checkWorkflowStates, qualificationWorkflows } from "./qualification.mjs";

const refuse = (message) => { throw new ReleaseError(message); };
const branchName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// GitHub's comparison API returns at most 100 commits per paginated response.
export const comparisonPageSize = 100;
const fullSha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

// Chooses the commit the target branch moves forward to: the newest commit of the source branch,
// ahead of the target, whose newest full check on a push passed. A newer commit whose check failed
// or still runs waits for the next promotion; an older green run never stands in for it.
export async function selectPromotion(github, {repository, workflowPath, requiredWorkflows = "", source = "dev", target = "main"}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      ![source, target].every((name) => branchName.test(name ?? "") && !name.includes("..")) || source === target)
    refuse("Promotion requires an exact repository and two different branch names.");
  const workflows = qualificationWorkflows(workflowPath, requiredWorkflows);
  const branch = async (name) => {
    const value = await github.json("GET", "/repos/" + repository + "/branches/" + encodeURIComponent(name));
    if (value?.name !== name || !fullSha(value.commit?.sha))
      refuse("The " + name + " branch has no verified commit identity.");
    return value.commit.sha;
  };
  const [sourceSha, targetSha] = await Promise.all([branch(source), branch(target)]);
  if (sourceSha === targetSha) return {state: "current"};
  const route = "/repos/" + repository + "/compare/" + targetSha + "..." + sourceSha + "?per_page=" + comparisonPageSize;
  const first = await github.json("GET", route + "&page=1");
  const valid = (value) => value && Number.isSafeInteger(value.ahead_by) && value.ahead_by >= 0 &&
    Number.isSafeInteger(value.behind_by) && value.behind_by >= 0 &&
    Number.isSafeInteger(value.total_commits) && value.total_commits >= 0 && Array.isArray(value.commits) &&
    value.base_commit?.sha === targetSha;
  if (!valid(first)) refuse("The branch comparison is malformed.");
  if (first.behind_by > 0)
    refuse(target + " has commits that " + source + " lacks; promotion only moves " + target + " forward.");
  if (!first.ahead_by || first.ahead_by !== first.total_commits || first.merge_base_commit?.sha !== targetSha)
    refuse("The branch comparison does not prove a complete forward history.");
  const total = first.total_commits, last = Math.ceil(total / comparisonPageSize);
  const skipped = [], seen = new Set();
  for (let page = last; page >= 1; page--) {
    const compare = page === 1 ? first : await github.json("GET", route + "&page=" + page);
    const expected = Math.min(comparisonPageSize, total - (page - 1) * comparisonPageSize);
    if (!valid(compare) || compare.ahead_by !== total || compare.total_commits !== total ||
        compare.behind_by !== 0 || compare.merge_base_commit?.sha !== targetSha || compare.commits.length !== expected)
      refuse("The branch comparison page is incomplete or inconsistent.");
    if (page === last && compare.commits.at(-1)?.sha !== sourceSha)
      refuse("The branch comparison does not end at the captured source commit.");
    for (const commit of [...compare.commits].reverse()) {
      if (!fullSha(commit?.sha) || seen.has(commit.sha)) refuse("The branch comparison repeats or malforms a commit.");
      seen.add(commit.sha);
      const selections = await checkWorkflowStates(github, {repository, sha: commit.sha, branch: source, event: "push"}, workflows);
      const blocked = selections.findIndex((selection) => selection.state !== "qualified");
      if (blocked < 0)
        return {state: "ready", sha: commit.sha, run_id: selections[0].run.id, skipped};
      const selection = selections[blocked];
      if (selection.state !== "missing" || workflows.length > 1)
        skipped.push({sha: commit.sha, state: selection.state, reason: workflows[blocked] + ": " + selection.reason});
    }
  }
  return {state: "unchecked", skipped};
}
