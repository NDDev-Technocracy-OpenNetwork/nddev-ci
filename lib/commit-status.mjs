import { ReleaseError } from "./release.mjs";

const refuse = (message) => { throw new ReleaseError(message); };
const positive = (value) => Number.isSafeInteger(value) && value > 0;

/** Reads one bounded combined-status snapshot; only the named creator/context can qualify it. */
export async function requireStatus(github, {repository, sha, context, creator, maximumStatuses}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      repository.split("/").some((part) => part === "." || part === "..") ||
      !/^[a-f0-9]{40}$/.test(sha ?? "") || typeof context !== "string" ||
      !context.trim() || context.length > 255 || /[\x00-\x1f\x7f]/.test(context) ||
      !positive(creator) || !positive(maximumStatuses))
    refuse("Status readiness needs an exact source, context, creator and positive inventory bound.");
  // The combined-status API returns the latest record for each context, at most 100 per page.
  const pages = Math.ceil(maximumStatuses / 100), ids = new Set(), contexts = new Set();
  let total, seen = 0, selected;
  for (let page = 1; page <= pages; page++) {
    const value = await github.json("GET", `/repos/${repository}/commits/${sha}/status?per_page=100&page=${page}`);
    if (value?.sha !== sha || value.repository?.full_name !== repository ||
        !Number.isSafeInteger(value.total_count) || value.total_count < 0 ||
        !Array.isArray(value.statuses) || value.statuses.length > 100 ||
        (total !== undefined && total !== value.total_count))
      refuse("The status inventory has malformed, changed or foreign identity.");
    total = value.total_count;
    if (total > maximumStatuses) refuse("The status inventory exceeds its configured bound.");
    if (value.statuses.length !== Math.min(100, total - seen))
      refuse("The status inventory is incomplete or inconsistent.");
    for (const status of value.statuses) {
      if (!positive(status?.id) || typeof status.context !== "string" || !status.context ||
          ids.has(status.id) || contexts.has(status.context))
        refuse("The status inventory repeats or lacks an identity.");
      ids.add(status.id); contexts.add(status.context);
      if (status.context === context) selected = status;
    }
    seen += value.statuses.length;
    if (seen === total) break;
  }
  if (seen !== total) refuse("The status inventory was not read completely.");
  if (!selected) refuse("The required readiness context is missing on this commit.");
  if (!positive(selected.creator?.id) || selected.creator.id !== creator)
    refuse("The readiness status was not written by the configured creator.");
  if (selected.state !== "success") {
    if (!["pending", "failure", "error"].includes(selected.state))
      refuse("The readiness status has an unknown state.");
    refuse(`The required readiness status is ${selected.state} on this commit.`);
  }
  return {state: "ready", sha, statusId: selected.id};
}
