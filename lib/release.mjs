// Release selection without network access: versions, the qualifying full check of the exact
// commit, and the bounded set of published files. actions/release performs the GitHub requests.

export class ReleaseError extends Error {}
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

export function parseVersion(text) {
  const match = versionPattern.exec(text ?? "");
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1)
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

// The next version: an explicit one the owner chose, otherwise one more than the newest release.
export function nextVersion({ tags, explicit, initial }) {
  const released = tags
    .filter((tag) => tag.startsWith("v"))
    .map((tag) => parseVersion(tag.slice(1)))
    .filter(Boolean)
    .sort(compareVersions);
  const newest = released.at(-1);
  if (explicit) {
    const chosen = parseVersion(explicit);
    if (!chosen) refuse("The chosen version must have three plain numbers.");
    if (newest && compareVersions(chosen, newest) <= 0)
      refuse("The chosen version must be newer than every release.");
    return chosen.join(".");
  }
  if (!newest) {
    const first = parseVersion(initial);
    if (!first) refuse("The initial version must have three plain numbers.");
    return first.join(".");
  }
  return [newest[0], newest[1], newest[2] + 1].join(".");
}

// The newest full check of the exact commit decides. An older green run never replaces a newer
// failed, cancelled or unknown one; a run still in progress is reported as pending.
export function selectQualifiedRun(runs, { sha, repository, workflowPath, branch, event = "push" }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) refuse("The release commit is not a full SHA.");
  if (!Array.isArray(runs) || runs.length > limits.runs)
    refuse("The qualifying run list is missing or exceeds its bound.");
  const pending = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
  const identities = new Map(), numbers = new Map(), attempts = new Set();
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
  }
  const candidates = runs.filter(
    (run) =>
      run.head_sha === sha &&
      run.head_branch === branch &&
      run.event === event &&
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
