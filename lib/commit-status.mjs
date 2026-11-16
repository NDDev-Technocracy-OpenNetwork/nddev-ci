import { ReleaseError } from "./release.mjs";

const refuse = (message) => { throw new ReleaseError(message); };
const positive = (value) => Number.isSafeInteger(value) && value > 0;

/** Reads a complete bounded status history; only the latest named creator/context can qualify it. */
export async function requireStatus(github, {repository, sha, context, creator, maximumStatuses}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      repository.split("/").some((part) => part === "." || part === "..") ||
      !/^[a-f0-9]{40}$/.test(sha ?? "") || typeof context !== "string" ||
      !context.trim() || context.length > 255 || /[\x00-\x1f\x7f]/.test(context) ||
      !positive(creator) || !positive(maximumStatuses))
    refuse("Status readiness needs an exact source, context, creator and positive inventory bound.");
  // The combined-status endpoint omits creator; the history endpoint includes it.
  // History is newest first. A full final page needs one empty read to prove completeness.
  const ids = new Set();
  let seen = 0, previous = Infinity, selected;
  for (let page = 1; page <= Math.ceil(maximumStatuses / 100) + 1; page++) {
    const rows = await github.json("GET", `/repos/${repository}/commits/${sha}/statuses?per_page=100&page=${page}`);
    if (!Array.isArray(rows) || rows.length > 100) refuse("The status history is malformed.");
    seen += rows.length;
    if (seen > maximumStatuses) refuse("The status history exceeds its configured bound.");
    for (const status of rows) {
      let url;
      try { url = new URL(status?.url); } catch { refuse("The status has no source identity."); }
      if (!positive(status.id) || status.id >= previous || ids.has(status.id) ||
          typeof status.context !== "string" || !status.context ||
          !url.pathname.endsWith(`/repos/${repository}/statuses/${sha}`) || url.search || url.hash)
        refuse("The status history has changed, repeated or foreign identity.");
      ids.add(status.id); previous = status.id;
      if (!selected && status.context === context) selected = status;
    }
    if (rows.length < 100) {
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
  }
  refuse("The status history was not read completely.");
}
