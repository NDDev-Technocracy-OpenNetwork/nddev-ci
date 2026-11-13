import { ReleaseError } from "./release.mjs";

const refuse = (message) => { throw new ReleaseError(message); };
const passed = new Set(["success", "skipped", "neutral"]);

// Chooses the pull request to merge for one commit: an open pull request of this repository whose
// head is exactly that commit, carries the label, and whose every check on that commit finished
// and passed. The workflow's own job is left out, since it runs while it decides. A repository
// without branch rules cannot use GitHub's auto-merge; this gives it the same result.
export async function selectMerge(github, {repository, sha, label = "merge-on-green", self = ""}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !/^[0-9a-f]{40}$/.test(sha ?? "") ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._:-]*$/.test(label ?? ""))
    refuse("Merging requires an exact repository, commit and label.");
  const pulls = await github.json("GET", `/repos/${repository}/commits/${sha}/pulls?per_page=100`);
  if (!Array.isArray(pulls)) refuse("The pull requests of the commit are malformed.");
  const candidates = pulls.filter((pull) => pull?.state === "open" && pull.head?.sha === sha &&
    pull.head?.repo?.full_name === repository && pull.base?.repo?.full_name === repository &&
    !pull.draft && (pull.labels ?? []).some((item) => item?.name === label));
  if (!candidates.length) return {state: "none"};
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const listed = await github.json("GET", `/repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    if (!listed || !Array.isArray(listed.check_runs)) refuse("The checks of the commit are malformed.");
    runs.push(...listed.check_runs);
    if (listed.check_runs.length < 100) break;
  }
  const others = runs.filter((run) => run?.name !== self);
  const waiting = others.filter((run) => run?.status !== "completed");
  if (waiting.length) return {state: "pending", reason: `${waiting.length} checks still run`};
  const failed = others.filter((run) => !passed.has(run?.conclusion));
  if (failed.length) return {state: "failed", reason: failed.map((run) => `${run.name}: ${run.conclusion}`).join(", ")};
  if (!others.some((run) => run?.conclusion === "success")) return {state: "pending", reason: "no check has passed yet"};
  const statuses = await github.json("GET", `/repos/${repository}/commits/${sha}/status`);
  if (statuses?.total_count > 0 && statuses.state !== "success")
    return {state: statuses.state === "pending" ? "pending" : "failed", reason: `commit statuses are ${statuses.state}`};
  const pull = candidates.sort((a, b) => a.number - b.number)[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pull.base?.ref ?? "") || pull.base.ref.includes(".."))
    refuse("The pull request's base branch is malformed.");
  return {state: "ready", number: pull.number, base: pull.base.ref, head: pull.head.ref, title: pull.title ?? ""};
}
