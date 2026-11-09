// Publishes one immutable GitHub Release of the exact commit that its full check on the
// integration branch verified, reusing that check's artifacts instead of building again.
// Every step reconciles what already exists, so a rerun completes the same release once.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  ReleaseError,
  artifactNames,
  checkFiles,
  checksums,
  nextVersion,
  parseVersion,
  selectQualifiedRun,
  validPrefix,
} from "../../lib/release.mjs";

const refuse = (message) => {
  throw new ReleaseError(message);
};
const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
const environment = (name) =>
  process.env[name] || refuse(`The runner did not provide ${name}.`);

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

function client(token) {
  const api = environment("GITHUB_API_URL");
  async function request(method, route, { body, accept, raw } = {}) {
    const url = route.startsWith("https://") ? route : `${api}${route}`;
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: accept ?? "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "nddev-ci",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined || raw ? {} : { "Content-Type": "application/json" }),
          ...(raw ? raw.headers : {}),
        },
        body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
        ...(raw ? { duplex: "half" } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(raw ? 900000 : 60000),
      });
      // Only idempotent reads repeat after a transient server answer.
      if (method === "GET" && [502, 503, 504].includes(response.status) && attempt < 3) {
        await response.body?.cancel();
        console.log(`GitHub answered ${response.status}; repeating the same read (${attempt + 1}/3).`);
        await delay(2 ** attempt * 2000);
        continue;
      }
      return response;
    }
  }
  async function json(method, route, options = {}) {
    const response = await request(method, route, options);
    if (response.status === 404 && options.optional) return null;
    if (!response.ok)
      refuse(`GitHub ${method} ${route.split("?")[0]} failed with HTTP ${response.status}.`);
    return response.status === 204 ? null : response.json();
  }
  return { request, json };
}

// A GitHub artifact archive arrives through a short-lived storage redirect without credentials.
async function downloadArtifact(github, artifact, destination) {
  const response = await github.request(
    "GET",
    `/repos/${environment("GITHUB_REPOSITORY")}/actions/artifacts/${artifact.id}/zip`,
  );
  if (response.status !== 302) refuse(`Artifact ${artifact.name} has no download redirect.`);
  const location = new URL(response.headers.get("location") ?? "");
  await response.body?.cancel();
  if (location.protocol !== "https:") refuse("The artifact redirect is not HTTPS.");
  const download = await fetch(location, {
    redirect: "error",
    signal: AbortSignal.timeout(900000),
  });
  if (!download.ok || !download.body) refuse(`Artifact ${artifact.name} download failed.`);
  const hash = createHash("sha256");
  let size = 0;
  const output = openSync(destination, "wx", 0o600);
  try {
    for await (const chunk of download.body) {
      size += chunk.byteLength;
      if (size > artifact.size_in_bytes) refuse(`Artifact ${artifact.name} exceeds its size.`);
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) written += writeSync(output, chunk, written, chunk.length - written);
    }
  } finally {
    closeSync(output);
  }
  if (size !== artifact.size_in_bytes) refuse(`Artifact ${artifact.name} arrived incomplete.`);
  if (artifact.digest && artifact.digest !== `sha256:${hash.digest("hex")}`)
    refuse(`Artifact ${artifact.name} differs from its recorded digest.`);
}

// Extracts only regular files at the archive's top level; folders, links and escaping names refuse.
function extract(archive, folder) {
  const script = `
import os, stat, sys, zipfile
archive, folder = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(archive) as z:
    for info in z.infolist():
        name = info.filename
        mode = info.external_attr >> 16
        if info.is_dir() or "/" in name or "\\\\" in name or name in ("", ".", "..") or name.startswith("."):
            sys.exit("artifact entries must be plain files at the top level: " + repr(name))
        if mode and not stat.S_ISREG(mode):
            sys.exit("artifact entry is not a regular file: " + repr(name))
        target = os.path.join(folder, name)
        with z.open(info) as source, open(target, "xb") as sink:
            while chunk := source.read(1048576):
                sink.write(chunk)
`;
  const result = spawnSync("python3", ["-I", "-c", script, archive, folder], {
    encoding: "utf8",
    timeout: 900000,
  });
  if (result.error || result.status !== 0)
    refuse(`Artifact extraction refused: ${(result.stderr || "").trim().slice(0, 300)}`);
}

async function main() {
  const repository = environment("GITHUB_REPOSITORY");
  const sha = environment("GITHUB_SHA");
  const ref = environment("GITHUB_REF");
  const temp = environment("RUNNER_TEMP");
  const releaseBranch = input("release-branch") || "main";
  const checkBranch = input("check-branch") || "dev";
  const workflow = input("check-workflow") || "ci.yml";
  const prefix = validPrefix(input("tag-prefix") || "v");
  const waitMinutes = Number(input("wait-minutes") || "30");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(workflow))
    refuse("check-workflow must be a workflow file name in .github/workflows.");
  if (!Number.isInteger(waitMinutes) || waitMinutes < 0 || waitMinutes > 120)
    refuse("wait-minutes must be a whole number from 0 to 120.");
  if (ref !== `refs/heads/${releaseBranch}`)
    refuse(`A release publishes only commits of ${releaseBranch}; this run is on ${ref}.`);
  const github = client(input("github-token") || refuse("A token is required."));

  // 1. The newest full check of this exact commit on the integration branch.
  const deadline = Date.now() + waitMinutes * 60000;
  let selection;
  for (;;) {
    const listed = await github.json(
      "GET",
      `/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${sha}&branch=${encodeURIComponent(checkBranch)}&event=push&per_page=100`,
    );
    selection = selectQualifiedRun(listed.workflow_runs, {
      sha,
      repository,
      workflowPath: `.github/workflows/${workflow}`,
      branch: checkBranch,
    });
    if (selection.state !== "pending" || Date.now() > deadline) break;
    console.log(`${selection.reason} Waiting for its result.`);
    await delay(30000);
  }
  if (selection.state !== "qualified") refuse(`No release: ${selection.reason}`);
  const run = selection.run;
  console.log(`Qualified by ${run.html_url} (attempt ${run.run_attempt}).`);

  // 2. The verified artifacts of that run, without a new build.
  const names = artifactNames(input("artifacts"));
  const folder = path.join(temp, "nddev-ci-release", sha);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const files = [];
  if (names.length) {
    const listed = await github.json(
      "GET",
      `/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    );
    for (const name of names) {
      const matches = listed.artifacts.filter((artifact) => artifact.name === name);
      if (matches.length !== 1 || matches[0].expired)
        refuse(`Artifact ${name} of run ${run.id} is missing, repeated or expired.`);
      const archive = path.join(temp, "nddev-ci-release", `${matches[0].id}.zip`);
      await downloadArtifact(github, matches[0], archive);
      const before = new Set(readdirSync(folder));
      extract(archive, folder);
      for (const entry of readdirSync(folder))
        if (!before.has(entry)) {
          const file = path.join(folder, entry);
          const stat = lstatSync(file);
          if (!stat.isFile()) refuse(`Release input ${entry} is not a regular file.`);
          files.push({ name: entry, path: file, size: stat.size, sha256: await sha256(file) });
        }
    }
  }
  const planned = checkFiles(files);
  if (planned.length) {
    const sums = path.join(folder, "SHA256SUMS");
    writeFileSync(sums, checksums(planned), { flag: "wx", mode: 0o600 });
    const stat = lstatSync(sums);
    planned.push({ name: "SHA256SUMS", path: sums, size: stat.size, sha256: await sha256(sums) });
  }

  // 3. The version: the one this commit already carries, otherwise the next one.
  const refs =
    (await github.json("GET", `/repos/${repository}/git/matching-refs/tags/${encodeURIComponent(prefix)}`)) ?? [];
  if (refs.length > 1000) refuse("Too many release tags to compare.");
  async function target(object) {
    for (let depth = 0; object.type === "tag" && depth < 4; depth += 1)
      object = (await github.json("GET", `/repos/${repository}/git/tags/${object.sha}`)).object;
    return object.type === "commit" ? object.sha : null;
  }
  const tags = refs.map((item) => item.ref.slice("refs/tags/".length));
  let version = null;
  for (const item of refs) {
    const tag = item.ref.slice("refs/tags/".length);
    if (parseVersion(tag.slice(prefix.length)) && (await target(item.object)) === sha) {
      if (version) refuse(`Commit ${sha} already carries two release versions.`);
      version = tag.slice(prefix.length);
    }
  }
  version ??= nextVersion({
    tags,
    prefix,
    explicit: input("version"),
    initial: input("initial-version") || "0.1.0",
  });
  const tag = `${prefix}${version}`;

  // 4. The tag never moves: it is created at this commit or must already point here.
  const existingTag = await github.json("GET", `/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`, {
    optional: true,
  });
  if (existingTag) {
    if ((await target(existingTag.object)) !== sha) refuse(`Tag ${tag} points to another commit.`);
  } else
    await github.json("POST", `/repos/${repository}/git/refs`, {
      body: { ref: `refs/tags/${tag}`, sha },
    });

  // 5. One draft release receives and verifies every file before it is published.
  let release = await github.json("GET", `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
    optional: true,
  });
  if (!release) {
    const listed = await github.json("GET", `/repos/${repository}/releases?per_page=100`);
    release = listed.find((item) => item.tag_name === tag) ?? null;
  }
  if (!release) {
    const notes = await github.json("POST", `/repos/${repository}/releases/generate-notes`, {
      body: { tag_name: tag, target_commitish: sha },
    });
    const title = input("name") || repository.split("/")[1];
    release = await github.json("POST", `/repos/${repository}/releases`, {
      body: {
        tag_name: tag,
        target_commitish: sha,
        draft: true,
        name: `${title} ${version}`,
        body: `${notes.body}\n\nVerified by ${run.html_url}.\n`,
      },
    });
  }
  const allowed = new Map(planned.map((file) => [file.name, file]));
  for (const asset of release.assets ?? [])
    if (!allowed.has(asset.name)) refuse(`Release ${tag} holds an unexpected file ${asset.name}.`);
  for (const file of planned) {
    const existing = (release.assets ?? []).find((asset) => asset.name === file.name);
    if (existing && existing.size === file.size && existing.digest === `sha256:${file.sha256}`) continue;
    if (!release.draft) refuse(`Published release ${tag} differs from its verified file ${file.name}.`);
    if (existing)
      await github.json("DELETE", `/repos/${repository}/releases/assets/${existing.id}`);
    const upload = release.upload_url.replace(/\{.*\}$/, "");
    const response = await github.request("POST", `${upload}?name=${encodeURIComponent(file.name)}`, {
      raw: {
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(file.size) },
        body: createReadStream(file.path),
      },
    });
    if (!response.ok) refuse(`Uploading ${file.name} failed with HTTP ${response.status}.`);
    const uploaded = await response.json();
    if (uploaded.size !== file.size || uploaded.digest !== `sha256:${file.sha256}`)
      refuse(`GitHub recorded different bytes for ${file.name}.`);
  }
  if (release.draft)
    release = await github.json("PATCH", `/repos/${repository}/releases/${release.id}`, {
      body: { draft: false, make_latest: "true" },
    });

  const output = environment("GITHUB_OUTPUT");
  appendFileSync(
    output,
    `version=${version}\ntag=${tag}\nurl=${release.html_url}\nrun-id=${run.id}\n`,
  );
  appendFileSync(
    environment("GITHUB_STEP_SUMMARY"),
    `### Release ${tag}\n\n${release.html_url}\n\nCommit \`${sha}\`, verified by ${run.html_url}; ${planned.length} files.\n`,
  );
  console.log(`Published ${release.html_url}.`);
}

main().catch((error) => {
  const message = error instanceof ReleaseError ? error.message : `Release failed: ${error.message}`;
  console.log(`::error::${message.replace(/[\r\n%]/g, " ")}`);
  process.exitCode = 1;
});
