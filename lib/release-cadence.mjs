// The optional daily contract reads published releases; drafts do not consume a UTC date.
// The publisher holds its workflow concurrency lock through the final publication check.
import { ReleaseError } from "./release.mjs";
import { tagCommit } from "./release-version.mjs";
const refuse = (message) => { throw new ReleaseError(message); };
export function dailyEnabled(value) {
  if (value === "true") return true;
  if (value === "" || value === "false" || value === undefined) return false;
  refuse("daily-release must be true or false.");
}
export async function dailyPublication(github, {repository, sha, tag, currentSource = false, now = new Date()}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      !/^[0-9a-f]{40}$/.test(sha ?? "") || !(now instanceof Date) || !Number.isFinite(now.getTime()))
    refuse("Daily publication requires an exact repository, source and clock.");
  const releases = [], identities = new Set(), tags = new Set();
  for (let page = 1; ; page++) {
    const batch = await github.json("GET", `/repos/${repository}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length > 100)
      refuse("The daily release inventory is malformed.");
    for (const release of batch) {
      if (!Number.isSafeInteger(release?.id) || release.id < 1 || identities.has(release.id) ||
          typeof release.draft !== "boolean" || typeof release.tag_name !== "string" ||
          release.tag_name.length < 1 || release.tag_name.length > 1024 || /[\x00-\x20\x7f]/.test(release.tag_name) ||
          tags.has(release.tag_name))
        refuse("The daily release inventory has an invalid or repeated identity.");
      identities.add(release.id); tags.add(release.tag_name);
      if (release.draft) continue;
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(release.published_at ?? "") ||
          !Number.isFinite(Date.parse(release.published_at)) ||
          new Date(release.published_at).toISOString().replace(".000Z", "Z") !== release.published_at ||
          Date.parse(release.published_at) > now.getTime())
        refuse("A published release has an invalid publication time.");
      releases.push(release);
    }
    if (batch.length < 100) break;
    if (page === 10) refuse("The daily release inventory exceeds its bound.");
  }
  const date = now.toISOString().slice(0, 10);
  const existing = tag && releases.find((release) => release.tag_name === tag);
  async function source(release) {
    const ref = await github.json("GET", `/repos/${repository}/git/ref/tags/${encodeURIComponent(release.tag_name)}`);
    if (ref?.ref !== `refs/tags/${release.tag_name}`) refuse("The release tag response has another identity.");
    return tagCommit(github, repository, ref?.object);
  }
  if (existing) {
    if (await source(existing) !== sha) refuse("The replayed release belongs to another source.");
    return {state: "replay", date};
  }
  if (releases.some((release) => release.published_at.slice(0, 10) === date))
    return {state: "held", date};
  const latest = releases.reduce((best, release) =>
    !best || Date.parse(release.published_at) > Date.parse(best.published_at) ? release : best, null);
  return {state: "ready", date, ...(currentSource && latest ? {latestSource: await source(latest)} : {})};
}
