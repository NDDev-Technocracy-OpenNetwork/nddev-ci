import { ReleaseError } from "./release.mjs";

const refuse = (message) => { throw new ReleaseError(message); };
const passed = new Set(["success", "skipped", "neutral"]);
const actionsApp = 15368;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const checkName = (value) => typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value);

// Read all attempts: the API's default completed-at filter can hide a newer pending result.
// A repeated or changing page cannot establish the newest result of a named integration.
async function checks(github, repository, sha) {
  let total;
  const ids = new Set(), latest = new Map();
  for (let page = 1; page <= 10; page++) {
    const listed = await github.json("GET", `/repos/${repository}/commits/${sha}/check-runs?filter=all&per_page=100&page=${page}`);
    if (!Number.isSafeInteger(listed?.total_count) || listed.total_count < 0 || listed.total_count > 1000 ||
        !Array.isArray(listed.check_runs) || listed.check_runs.length > 100 ||
        (total !== undefined && total !== listed.total_count))
      refuse("The check inventory is malformed, changed or exceeds its bound.");
    total = listed.total_count;
    for (const run of listed.check_runs) {
      if (!positive(run?.id) || ids.has(run.id) || !checkName(run.name) || run.head_sha !== sha ||
          !positive(run.app?.id) || typeof run.app.slug !== "string" || !run.app.slug)
        refuse("The checks have repeated, malformed or foreign source identity.");
      ids.add(run.id);
      const key = `${run.app.id}:${run.name}`;
      if (!latest.has(key) || latest.get(key).id < run.id) latest.set(key, run);
    }
    if (ids.size > total) refuse("The check inventory has changed during the read.");
    if (ids.size === total) return [...latest.values()];
    if (listed.check_runs.length < 100) refuse("The check inventory is incomplete.");
  }
  refuse("The check inventory was not read completely.");
}

// Only the newest result of every declared mandatory Actions check can authorize this exact
// head. Optional jobs keep their normal skip semantics; none can replace mandatory success.
export async function selectMerge(github, {repository, sha, requiredChecks, label = "merge-on-green", self = ""}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      repository.split("/").some((part) => part === "." || part === "..") || !/^[0-9a-f]{40}$/.test(sha ?? "") ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._:-]*$/.test(label ?? ""))
    refuse("Merging requires an exact repository, commit and label.");
  const required = typeof requiredChecks === "string" ? requiredChecks.split(/\r?\n/).map((name) => name.trim()).filter(Boolean) : [];
  if (!required.length || required.length > 100 || required.some((name) => !checkName(name) || name === self) ||
      new Set(required).size !== required.length)
    refuse("Mandatory check names must be explicit, unique and separate from the merge job.");
  const pulls = await github.json("GET", `/repos/${repository}/commits/${sha}/pulls?per_page=100`);
  if (!Array.isArray(pulls)) refuse("The pull requests of the commit are malformed.");
  const candidates = pulls.filter((pull) => pull?.state === "open" && pull.head?.sha === sha &&
    pull.head?.repo?.full_name === repository && pull.base?.repo?.full_name === repository &&
    !pull.draft && (pull.labels ?? []).some((item) => item?.name === label));
  if (!candidates.length) return {state: "none"};
  const others = (await checks(github, repository, sha)).filter((run) => run.name !== self);
  for (const name of required) {
    const matching = others.filter((run) => run.name === name);
    const run = matching.find((run) => run.app.id === actionsApp && run.app.slug === "github-actions");
    if (!run) return {state: matching.length ? "failed" : "pending", reason: `mandatory Actions check is missing: ${name}`};
    if (run.status !== "completed") return {state: "pending", reason: `mandatory check still runs: ${name}`};
    if (run.conclusion !== "success") return {state: "failed", reason: `mandatory check ${name}: ${run.conclusion}`};
  }
  const waiting = others.filter((run) => run.status !== "completed");
  if (waiting.length) return {state: "pending", reason: `${waiting.length} checks still run`};
  const failed = others.filter((run) => !passed.has(run.conclusion));
  if (failed.length) return {state: "failed", reason: failed.map((run) => `${run.name}: ${run.conclusion}`).join(", ")};
  const statuses = await github.json("GET", `/repos/${repository}/commits/${sha}/status`);
  if (!Number.isSafeInteger(statuses?.total_count) || statuses.total_count < 0 || statuses.sha !== sha ||
      !["success", "pending", "failure", "error"].includes(statuses.state))
    refuse("The commit statuses have malformed or foreign source identity.");
  if (statuses.state !== "success" && (statuses.total_count > 0 || statuses.state !== "pending"))
    return {state: statuses.state === "pending" ? "pending" : "failed", reason: `commit statuses are ${statuses.state}`};
  const pull = candidates.sort((a, b) => a.number - b.number)[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pull.base?.ref ?? "") || pull.base.ref.includes(".."))
    refuse("The pull request's base branch is malformed.");
  return {state: "ready", number: pull.number, base: pull.base.ref, head: pull.head.ref, title: pull.title ?? ""};
}
