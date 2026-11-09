import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, createReadStream, mkdtempSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ReleaseError, artifactNames, limits, selectQualifiedRun } from "./release.mjs";

const refuse = (message) => { throw new ReleaseError(message); };
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

function transportUrl(value) {
  let url;
  try { url = new URL(value); } catch { refuse("Invalid declared transport URL."); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.hash || /[\r\n\0]/.test(value))
    refuse("Transport URLs require HTTPS without credentials or fragments.");
  return url;
}

export function client(token, api = "https://api.github.com") {
  const base = transportUrl(api);
  if (base.search) refuse("The API base cannot contain a query.");
  async function request(method, route, {body, accept, raw, upload = false, timeout = 60000} = {}) {
    const url = transportUrl(/^https?:/.test(route) ? route : `${base.href.replace(/\/$/, "")}${route}`);
    const uploadOrigin = base.hostname === "api.github.com" ? "https://uploads.github.com" : base.origin;
    if (url.origin !== base.origin && !(upload && method === "POST" && url.origin === uploadOrigin))
      refuse("API credentials cannot leave their declared origin.");
    try {
      return await fetch(url, {
        method, redirect: "manual", signal: AbortSignal.timeout(Math.max(1, timeout)),
        headers: {Accept: accept ?? "application/vnd.github+json", ...(token ? {Authorization: `Bearer ${token}`} : {}),
          "User-Agent": "nddev-ci", "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined || raw ? {} : {"Content-Type": "application/json"}), ...(raw?.headers ?? {})},
        body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
        ...(raw ? {duplex: "half"} : {}),
      });
    } catch { refuse("The declared API transport did not complete."); }
  }
  async function json(method, route, options = {}) {
    const response = await request(method, route, options);
    if (response.status === 404 && options.optional) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); refuse(`The API request failed with HTTP ${response.status}.`); }
    if (response.status === 204) return null;
    try { return await response.json(); } catch { refuse("The API returned malformed JSON."); }
  }
  return {request, json};
}

function identity(value) {
  const {repository, sha, workflowPath, branch, event = "push"} = value;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      !/^[a-f0-9]{40}$/.test(sha ?? "") ||
      !/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(workflowPath ?? "") ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch ?? "") || branch.includes("..") ||
      !["push", "workflow_dispatch"].includes(event))
    refuse("Qualification requires an exact repository, commit, full-check workflow, branch and event.");
  return {repository, sha, workflowPath, branch, event};
}

export async function qualify(github, expected, {waitMinutes = 30, now = Date.now, sleep = delay} = {}) {
  const where = identity(expected);
  if (!Number.isInteger(waitMinutes) || waitMinutes < 0 || waitMinutes > 120)
    refuse("wait-minutes must be a whole number from 0 to 120.");
  const deadline = now() + waitMinutes * 60000;
  for (;;) {
    const workflow = where.workflowPath.split("/").at(-1);
    const listed = await github.json("GET", `/repos/${where.repository}/actions/workflows/${workflow}/runs?head_sha=${where.sha}&branch=${encodeURIComponent(where.branch)}&event=${where.event}&per_page=100`,
      {timeout: waitMinutes === 0 ? 60000 : Math.min(60000, Math.max(1, deadline - now()))});
    if (!Number.isSafeInteger(listed?.total_count) || listed.total_count < 0 || listed.total_count > limits.runs ||
        !Array.isArray(listed.workflow_runs) || listed.workflow_runs.length !== listed.total_count)
      refuse("The qualifying run inventory is malformed or truncated.");
    if (listed.workflow_runs.some((run) => run?.head_sha !== where.sha || run.head_branch !== where.branch ||
        run.event !== where.event || run.path !== where.workflowPath || run.repository?.full_name !== where.repository ||
        run.head_repository?.full_name !== where.repository))
      refuse("No qualification: the filtered run inventory contains foreign identity.");
    const selection = selectQualifiedRun(listed.workflow_runs, where);
    if (selection.state === "qualified") {
      const run = selection.run;
      return {schema_version: 1, ...where, run_id: run.id, run_attempt: run.run_attempt,
        run_number: run.run_number, run_started_at: run.run_started_at};
    }
    if (selection.state !== "pending" || now() >= deadline) refuse(`No qualification: ${selection.reason}`);
    await sleep(Math.min(30000, deadline - now()));
  }
}

export function receipt(value) {
  if (value?.schema_version !== 1 || ![value.run_id, value.run_attempt, value.run_number].every(positive) || !timestamp(value.run_started_at))
    refuse("The qualification receipt has malformed run or attempt identity.");
  return {...identity(value), schema_version: 1, run_id: value.run_id, run_attempt: value.run_attempt,
    run_number: value.run_number, run_started_at: value.run_started_at};
}

export async function recheck(github, qualified) {
  const expected = receipt(qualified);
  const current = await qualify(github, expected, {waitMinutes: 0});
  if (["run_id", "run_attempt", "run_number", "run_started_at"].some((key) => current[key] !== expected[key]))
    refuse("A newer run or attempt replaced the qualification receipt.");
  return current;
}

export function selectArtifacts(listed, qualified, names, now = Date.now()) {
  const run = receipt(qualified);
  if (!Number.isSafeInteger(listed?.total_count) || listed.total_count < 0 || listed.total_count > 100 ||
      !Array.isArray(listed.artifacts) || listed.artifacts.length !== listed.total_count)
    refuse("The artifact inventory is malformed or truncated.");
  let total = 0;
  return names.map((name) => {
    const matches = listed.artifacts.filter((artifact) => artifact.name === name);
    for (const artifact of matches) {
      if (!positive(artifact.id) || !positive(artifact.size_in_bytes) || artifact.size_in_bytes > limits.fileBytes ||
          !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") || !timestamp(artifact.created_at) || !timestamp(artifact.expires_at) ||
          artifact.workflow_run?.id !== run.run_id || artifact.workflow_run?.head_sha !== run.sha || artifact.workflow_run?.head_branch !== run.branch)
        refuse("Artifact identity, ownership, size or digest is malformed.");
    }
    const fresh = matches.filter((artifact) => Date.parse(artifact.created_at) >= Date.parse(run.run_started_at));
    if (fresh.length !== 1 || fresh[0].expired !== false || Date.parse(fresh[0].expires_at) <= now)
      refuse(`Artifact ${name} of the qualified attempt is missing, repeated, stale or expired.`);
    total += fresh[0].size_in_bytes;
    if (total > limits.totalBytes) refuse("The selected artifact bytes exceed their bound.");
    return fresh[0];
  });
}

export async function downloadArtifact(github, repository, artifact, destination, transport = {}) {
  const route = `/repos/${repository}/actions/artifacts/${artifact.id}/zip`;
  const source = transport.apiUrl ? client(transport.token ?? "", transport.apiUrl) : github;
  let response = await source.request("GET", route, {timeout: 900000});
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    const url = transportUrl(location);
    try { response = await fetch(url, {redirect: "error", signal: AbortSignal.timeout(900000)}); }
    catch { refuse("Artifact storage transport did not complete."); }
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); refuse("Artifact download failed."); }
  const hash = createHash("sha256");
  let size = 0;
  const output = openSync(destination, "wx", 0o600);
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > artifact.size_in_bytes) refuse("Artifact download exceeds its recorded size.");
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) written += writeSync(output, chunk, written, chunk.length - written);
    }
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    refuse("Artifact streaming did not complete.");
  } finally { closeSync(output); }
  if (size !== artifact.size_in_bytes || artifact.digest !== `sha256:${hash.digest("hex")}`)
    refuse("Artifact bytes differ from their recorded size or digest.");
}

function extract(archive, folder) {
  const script = `
import os, re, stat, sys, zipfile
archive, folder, max_files, max_file, max_total = sys.argv[1:]
with zipfile.ZipFile(archive) as z:
    entries = z.infolist()
    if len(entries) > int(max_files) or sum(i.file_size for i in entries) > int(max_total):
        sys.exit("artifact inventory exceeds its bounds")
    for info in entries:
        mode = info.external_attr >> 16
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,199}", info.filename) or info.is_dir() or (mode and not stat.S_ISREG(mode)) or info.file_size > int(max_file):
            sys.exit("artifact entries must be bounded regular top-level files")
        target = os.path.join(folder, info.filename)
        with z.open(info) as source, open(target, "xb") as sink:
            size = 0
            while chunk := source.read(1048576):
                size += len(chunk)
                if size > info.file_size:
                    sys.exit("artifact member exceeds its declared size")
                sink.write(chunk)
        if mode & stat.S_IXUSR:
            os.chmod(target, 0o700)
`;
  const result = spawnSync("python3", ["-I", "-c", script, archive, folder,
    String(limits.files), String(limits.fileBytes), String(limits.totalBytes)], {encoding: "utf8", timeout: 900000});
  if (result.error || result.status !== 0) refuse("Artifact extraction refused unsafe or malformed entries.");
}

export async function transferArtifacts(github, qualified, text, destination, transport = {}) {
  const names = artifactNames(text);
  if (!names.length) refuse("At least one qualified artifact must be named.");
  const run = await recheck(github, qualified);
  const listed = await github.json("GET", `/repos/${run.repository}/actions/runs/${run.run_id}/artifacts?per_page=100`);
  const selected = selectArtifacts(listed, run, names);
  const stage = mkdtempSync(path.join(path.dirname(destination), ".checked-artifacts-"));
  const files = [];
  try {
    for (const artifact of selected) {
      const archive = `${stage}-${artifact.id}.zip`;
      try { await downloadArtifact(github, run.repository, artifact, archive, transport); extract(archive, stage); }
      finally { rmSync(archive, {force: true}); }
    }
    let total = 0;
    const seen = new Set();
    for (const name of readdirSync(stage).sort()) {
      const file = path.join(stage, name), stat = statSync(file), folded = name.toLowerCase();
      if (seen.has(folded) || !stat.isFile() || !positive(stat.size) || files.length >= limits.files || (total += stat.size) > limits.totalBytes)
        refuse("Transferred files are empty, repeated or exceed their inventory bound.");
      seen.add(folded);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      files.push({name, size: stat.size, sha256: hash.digest("hex"), path: path.join(destination, name)});
    }
    await recheck(github, run);
    renameSync(stage, destination);
    return {schema_version: 1, qualification: run, artifacts: selected.map(({id, name, digest}) => ({id, name, digest})), files};
  } finally { rmSync(stage, {recursive: true, force: true}); }
}
