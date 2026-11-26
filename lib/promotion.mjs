import { ReleaseError } from "./release.mjs";
import { checkWorkflowStates, qualificationWorkflows } from "./qualification.mjs";

const refuse = (message) => { throw new ReleaseError(message); };
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// GitHub's comparison API returns at most 100 commits per paginated response.
export const comparisonPageSize = 100;
const fullSha = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

export async function branchSha(github, repository, name) {
  if (!repositoryName.test(repository ?? "") || !branchName.test(name ?? "") || name.includes(".."))
    refuse("Promotion requires an exact repository and branch name.");
  const value = await github.json("GET", "/repos/" + repository + "/branches/" + encodeURIComponent(name));
  if (value?.name !== name || !fullSha(value.commit?.sha))
    refuse("The " + name + " branch has no verified commit identity.");
  return value.commit.sha;
}

const validComparison = (value, base) => value && Number.isSafeInteger(value.ahead_by) && value.ahead_by >= 0 &&
  Number.isSafeInteger(value.behind_by) && value.behind_by >= 0 &&
  Number.isSafeInteger(value.total_commits) && value.total_commits >= 0 && Array.isArray(value.commits) &&
  value.base_commit?.sha === base;

const isStrictAncestor = (value, base) => validComparison(value, base) &&
  value.behind_by === 0 && value.ahead_by > 0 && value.ahead_by === value.total_commits &&
  value.commits.length === 1 && value.merge_base_commit?.sha === base;

const isStrictlyBehind = (value, base, head) => validComparison(value, base) &&
  value.ahead_by === 0 && value.behind_by > 0 && value.total_commits === 0 &&
  value.commits.length === 0 && value.merge_base_commit?.sha === head;

// Chooses the commit the target branch moves forward to: either one exact verified commit on the
// source branch when `sha` is supplied, or the newest commit of the source branch, ahead of the
// target, whose newest full check qualified. A newer commit whose check failed or still runs waits
// for the next promotion; an older green run never stands in for it.
export async function selectPromotion(github, {
  repository, workflowPath, requiredWorkflows = "", source = "dev", target = "main", sha = "", fallbackActorId,
}) {
  if (!repositoryName.test(repository ?? "") ||
      ![source, target].every((name) => branchName.test(name ?? "") && !name.includes("..")) || source === target)
    refuse("Promotion requires an exact repository and two different branch names.");
  if (typeof sha !== "string" || (sha !== "" && !fullSha(sha)))
    refuse("Promotion target commit must be a full 40-character lowercase hexadecimal SHA.");
  const workflows = qualificationWorkflows(workflowPath, requiredWorkflows);
  const [sourceSha, targetSha] = await Promise.all([
    branchSha(github, repository, source),
    branchSha(github, repository, target),
  ]);
  if (sha) {
    const compareOne = (base, head) =>
      github.json("GET", "/repos/" + repository + "/compare/" + base + "..." + head + "?per_page=1", {optional: true});
    if (sha !== sourceSha) {
      const onSource = await compareOne(sha, sourceSha);
      if (onSource === null) refuse("Commit " + sha + " was not found on " + source + ".");
      if (!validComparison(onSource, sha)) refuse("The branch comparison is malformed.");
      if (onSource.behind_by > 0) refuse("Commit " + sha + " is not an ancestor of " + source + ".");
      if (!isStrictAncestor(onSource, sha)) refuse("The branch comparison does not prove a complete forward history.");
    }
    if (sha === targetSha) return {state: "current"};
    const fromTarget = await compareOne(targetSha, sha);
    if (fromTarget === null)
      refuse(target + " has commits that " + sha + " lacks; promotion only moves " + target + " forward.");
    if (!validComparison(fromTarget, targetSha)) refuse("The branch comparison is malformed.");
    if (isStrictlyBehind(fromTarget, targetSha, sha)) {
      if (targetSha !== sourceSha) {
        const targetOnSource = await compareOne(targetSha, sourceSha);
        if (targetOnSource === null || (validComparison(targetOnSource, targetSha) && targetOnSource.behind_by > 0))
          refuse(target + " has commits that " + source + " lacks; promotion only moves " + target + " forward.");
        if (!isStrictAncestor(targetOnSource, targetSha))
          refuse("The branch comparison does not prove a complete forward history.");
      }
      return {state: "current"};
    }
    if (fromTarget.behind_by > 0)
      refuse(target + " has commits that " + sha + " lacks; promotion only moves " + target + " forward.");
    if (!isStrictAncestor(fromTarget, targetSha))
      refuse("The branch comparison does not prove a complete forward history.");
    const selections = await checkWorkflowStates(github, {repository, sha, branch: source, event: "push"}, workflows, {fallbackActorId});
    const blocked = selections.findIndex((selection) => selection.state !== "qualified");
    if (blocked < 0)
      return {state: "ready", sha, run_id: selections[0].run.id, target_sha: targetSha, skipped: []};
    const selection = selections[blocked];
    return {state: "unchecked", skipped: [{sha, state: selection.state, reason: workflows[blocked] + ": " + selection.reason}]};
  }
  if (sourceSha === targetSha) return {state: "current"};
  const route = "/repos/" + repository + "/compare/" + targetSha + "..." + sourceSha + "?per_page=" + comparisonPageSize;
  const first = await github.json("GET", route + "&page=1");
  const valid = (value) => validComparison(value, targetSha);
  if (!valid(first)) refuse("The branch comparison is malformed.");
  if (first.behind_by > 0)
    refuse(target + " has commits that " + source + " lacks; promotion only moves " + target + " forward.");
  if (!first.ahead_by || first.ahead_by !== first.total_commits || first.merge_base_commit?.sha !== targetSha)
    refuse("The branch comparison does not prove a complete forward history.");
  const total = first.total_commits, last = Math.ceil(total / comparisonPageSize);
  if (first.commits.length !== Math.min(total, comparisonPageSize) ||
      first.commits.some(commit => !fullSha(commit?.sha)) ||
      new Set(first.commits.map(commit => commit.sha)).size !== first.commits.length)
    refuse("The first branch comparison page is incomplete or malformed.");
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
      const selections = await checkWorkflowStates(github, {repository, sha: commit.sha, branch: source, event: "push"}, workflows, {fallbackActorId});
      const blocked = selections.findIndex((selection) => selection.state !== "qualified");
      if (blocked < 0)
        return {state: "ready", sha: commit.sha, run_id: selections[0].run.id, target_sha: targetSha, skipped};
      const selection = selections[blocked];
      if (selection.state !== "missing" || workflows.length > 1)
        skipped.push({sha: commit.sha, state: selection.state, reason: workflows[blocked] + ": " + selection.reason});
    }
  }
  return {state: "unchecked", skipped};
}
