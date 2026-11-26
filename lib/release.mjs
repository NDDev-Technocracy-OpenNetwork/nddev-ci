// Release selection without network access: versions, the qualifying full check of the exact
// commit, and the bounded set of published files. actions/release performs the GitHub requests.

export class ReleaseError extends Error {}
// The checked source still declares the newest released version: its next version comes from the
// source version update, so promotion waits for it instead of failing.
export class UnversionedError extends ReleaseError {}
const refuse = (message) => {
  throw new ReleaseError(message);
};

export const limits = Object.freeze({
  artifacts: 32,
  files: 128,
  fileBytes: 2 * 1024 ** 3 - 1,
  totalBytes: 8 * 1024 ** 3,
  runs: 100,
});

const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const prereleaseStagePattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})-(alpha|beta|rc)$/;
const releaseVersionPattern =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-(alpha|beta|rc)\.([1-9]\d{0,8}))?$/;
const stageRank = Object.freeze({ alpha: 0, beta: 1, rc: 2 });

export function parseVersion(text) {
  const match = versionPattern.exec(text ?? "");
  return match ? match.slice(1).map(Number) : null;
}

export function parsePrereleaseStage(text) {
  const match = prereleaseStagePattern.exec(text ?? "");
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  return { major, minor, patch, stage: match[4], base: `${major}.${minor}.${patch}` };
}

export function parseReleaseVersion(text) {
  const match = releaseVersionPattern.exec(text ?? "");
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const stage = match[4] ?? null;
  const number = match[5] ? Number(match[5]) : null;
  return { major, minor, patch, stage, number, base: `${major}.${minor}.${patch}`, text: match[0] };
}

export function isPrerelease(text) {
  return parseReleaseVersion(text)?.stage != null;
}

export function compareReleaseVersions(a, b) {
  for (const part of ["major", "minor", "patch"])
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  const rankA = a.stage === null ? 3 : stageRank[a.stage];
  const rankB = b.stage === null ? 3 : stageRank[b.stage];
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;
  if (a.number !== b.number) return a.number < b.number ? -1 : 1;
  return 0;
}

// The next version: an explicit one, a declared pre-release stage, or one step past the newest release.
export function newestRelease(tags) {
  return tags
    .filter((tag) => tag.startsWith("v"))
    .map((tag) => parseReleaseVersion(tag.slice(1)))
    .filter(Boolean)
    .sort(compareReleaseVersions)
    .at(-1);
}

export function previousReleaseTag(tags, version) {
  const target = parseReleaseVersion(version);
  if (!target) return null;
  const previous = tags
    .filter((tag) => tag.startsWith("v"))
    .map((tag) => parseReleaseVersion(tag.slice(1)))
    .filter((parsed) => parsed && compareReleaseVersions(parsed, target) < 0)
    .sort(compareReleaseVersions)
    .at(-1);
  return previous ? `v${previous.text}` : null;
}

export function nextVersion({ tags, explicit = "", initial = "0.1.0", prerelease = "" }) {
  const newest = newestRelease(tags);
  if (prerelease) {
    if (explicit) refuse("An explicit version cannot be used while a pre-release stage is declared.");
    const declared = parsePrereleaseStage(prerelease);
    if (!declared) refuse("The pre-release stage must have three plain numbers and alpha, beta or rc.");
    const first = parseReleaseVersion(`${declared.base}-${declared.stage}.1`);
    if (!newest || compareReleaseVersions(newest, first) < 0) return first.text;
    if (newest.base === declared.base && newest.stage === declared.stage) {
      const next = `${declared.base}-${declared.stage}.${newest.number + 1}`;
      if (!parseReleaseVersion(next)) refuse("The next pre-release number exceeds the supported version bounds.");
      return next;
    }
    refuse(`The pre-release stage ${prerelease} is not newer than release ${newest.text}.`);
  }
  if (explicit) {
    const chosen = parseVersion(explicit);
    if (!chosen) refuse("The chosen version must have three plain numbers.");
    const target = parseReleaseVersion(chosen.join("."));
    if (newest && compareReleaseVersions(target, newest) <= 0)
      refuse("The chosen version must be newer than every release.");
    return target.text;
  }
  if (!newest) {
    const first = parseVersion(initial);
    if (!first) refuse("The initial version must have three plain numbers.");
    return first.join(".");
  }
  if (newest.stage !== null) return newest.base;
  const next = [newest.major, newest.minor, newest.patch + 1].join(".");
  if (!parseVersion(next)) refuse("The next patch exceeds the supported version bounds.");
  return next;
}

// The newest full check of the exact commit decides. An older green run never replaces a newer
// failed, cancelled or unknown one; a run still in progress is reported as pending.
export function selectQualifiedRun(runs, { sha, repository, workflowPath, branch, event = "push" },
  acceptsEvent = (run) => run.event === event) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) refuse("The release commit is not a full SHA.");
  if (!Array.isArray(runs) || runs.length > limits.runs)
    refuse("The qualifying run list is missing or exceeds its bound.");
  const pending = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
  const identities = new Map(), numbers = new Map(), attempts = new Set(), latestAttempts = new Map();
  for (const run of runs) {
    if (!run || ![run.id, run.run_number, run.run_attempt].every((n) => Number.isSafeInteger(n) && n > 0) ||
        !/^[0-9a-f]{40}$/.test(run.head_sha ?? "") ||
        ![run.head_branch, run.event, run.path, run.repository?.full_name, run.head_repository?.full_name]
          .every((value) => typeof value === "string" && value.length > 0) ||
        ((run.status === "completed" || run.run_started_at != null) && !Number.isFinite(Date.parse(run.run_started_at ?? ""))))
      refuse("The qualifying run inventory contains malformed identity or attempt metadata.");
    if (run.status !== "completed" && (!pending.has(run.status) || run.conclusion !== null))
      refuse("The qualifying run inventory contains an unknown state.");
    const attempt = `${run.id}:${run.run_attempt}`;
    if (attempts.has(attempt) || (identities.has(run.id) && identities.get(run.id) !== run.run_number) ||
        (numbers.has(run.run_number) && numbers.get(run.run_number) !== run.id))
      refuse("The qualifying run inventory contains contradictory run or attempt identity.");
    attempts.add(attempt); identities.set(run.id, run.run_number); numbers.set(run.run_number, run.id);
    if ((latestAttempts.get(run.id)?.run_attempt ?? 0) < run.run_attempt) latestAttempts.set(run.id, run);
  }
  const candidates = [...latestAttempts.values()].filter(
    (run) =>
      run.head_sha === sha &&
      run.head_branch === branch &&
      acceptsEvent(run) &&
      run.path === workflowPath &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository,
  );
  if (!candidates.length)
    return { state: "missing", reason: `No ${branch} push check of ${sha} exists.` };
  const newest = candidates.reduce((best, run) =>
    run.run_number > best.run_number ||
    (run.run_number === best.run_number && run.run_attempt > best.run_attempt)
      ? run
      : best,
  );
  if (newest.status !== "completed")
    return { state: "pending", run: newest, reason: `Run ${newest.id} is ${newest.status}.` };
  if (newest.conclusion !== "success")
    return {
      state: "failed",
      run: newest,
      reason: `The newest check of ${sha}, run ${newest.id} attempt ${newest.run_attempt}, ended ${newest.conclusion}.`,
    };
  return { state: "qualified", run: newest };
}

export function artifactNames(text) {
  const names = (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (names.length > limits.artifacts) refuse("Too many release artifacts are named.");
  for (const name of names)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
      refuse(`Artifact name ${JSON.stringify(name)} is not a plain name.`);
  if (new Set(names).size !== names.length) refuse("An artifact is named twice.");
  return names;
}

// Published file names stay plain, unique without regard to case, and within GitHub's bounds.
export function checkFiles(files) {
  if (files.length > limits.files) refuse("The release holds too many files.");
  const seen = new Set();
  let total = 0;
  for (const file of files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(file.name) || file.name === "SHA256SUMS")
      refuse(`Release file ${JSON.stringify(file.name)} has no plain unique name.`);
    const folded = file.name.toLowerCase();
    if (seen.has(folded)) refuse(`Two release files are named ${file.name}.`);
    seen.add(folded);
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > limits.fileBytes)
      refuse(`Release file ${file.name} is empty or larger than GitHub accepts.`);
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) refuse(`Release file ${file.name} has no digest.`);
    total += file.size;
  }
  if (total > limits.totalBytes) refuse("The release files exceed their total bound.");
  return [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function checksums(files) {
  return files.map((file) => `${file.sha256}  ${file.name}\n`).join("");
}
