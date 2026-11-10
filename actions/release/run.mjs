// Publishes one immutable GitHub Release of the exact commit that its full check on the
// integration branch verified, reusing that check's artifacts instead of building again.
// Every step reconciles what already exists, so a rerun completes the same release once.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  mkdirSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  ReleaseError,
  artifactNames,
  checkFiles,
  checksums,
  nextVersion,
  parseVersion,
} from "../../lib/release.mjs";
import { client, qualify, recheck, transferArtifacts } from "../../lib/qualification.mjs";

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

async function main() {
  const repository = environment("GITHUB_REPOSITORY");
  const sha = environment("GITHUB_SHA");
  const ref = environment("GITHUB_REF");
  const temp = environment("RUNNER_TEMP");
  const workflow = input("check-workflow") || "ci.yml";
  const waitMinutes = Number(input("wait-minutes") || "30");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(workflow))
    refuse("check-workflow must be a workflow file name in .github/workflows.");
  if (!Number.isInteger(waitMinutes) || waitMinutes < 0 || waitMinutes > 120)
    refuse("wait-minutes must be a whole number from 0 to 120.");
  if (ref !== "refs/heads/main")
    refuse("A release publishes only commits of main.");
  const github = client(input("github-token") || refuse("A token is required."), input("api-url") || environment("GITHUB_API_URL"));

  // 1. The newest full check of this exact commit on the integration branch.
  const qualified = await qualify(github, {sha, repository, workflowPath: `.github/workflows/${workflow}`, branch: "dev"}, {waitMinutes});
  const run = {id: qualified.run_id, run_attempt: qualified.run_attempt,
    html_url: `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repository}/actions/runs/${qualified.run_id}`};
  console.log(`Qualified by ${run.html_url} (attempt ${run.run_attempt}).`);

  // 2. The verified artifacts of that attempt, without a new build.
  const names = artifactNames(input("artifacts"));
  const parent = path.join(temp, "nddev-ci-release");
  mkdirSync(parent, {recursive: true, mode: 0o700});
  const folder = path.join(parent, sha);
  let files = [];
  if (names.length) {
    const transferred = await transferArtifacts(github, qualified, names.join("\n"), folder,
      {apiUrl: input("artifact-api-url"), token: input("artifact-token")});
    files = transferred.files;
  } else mkdirSync(folder, {recursive: true, mode: 0o700});
  const planned = checkFiles(files);
  if (planned.length) {
    const sums = path.join(folder, "SHA256SUMS");
    writeFileSync(sums, checksums(planned), { flag: "wx", mode: 0o600 });
    const stat = lstatSync(sums);
    planned.push({ name: "SHA256SUMS", path: sums, size: stat.size, sha256: await sha256(sums) });
  }

  // 3. The version: the one this commit already carries, otherwise the next one.
  const refs =
    (await github.json("GET", `/repos/${repository}/git/matching-refs/tags/v`)) ?? [];
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
    if (parseVersion(tag.slice(1)) && (await target(item.object)) === sha) {
      if (version) refuse(`Commit ${sha} already carries two release versions.`);
      version = tag.slice(1);
    }
  }
  version ??= nextVersion({
    tags,
    explicit: input("version"),
    initial: input("initial-version") || "0.1.0",
  });
  const tag = `v${version}`;

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
    release = await github.json("POST", `/repos/${repository}/releases`, {
      body: {
        tag_name: tag,
        target_commitish: sha,
        draft: true,
        name: `${repository.split("/")[1]} ${version}`,
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
      upload: true,
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
  await recheck(github, qualified);
  if (release.draft)
    release = await github.json("PATCH", `/repos/${repository}/releases/${release.id}`, {
      body: { draft: false, make_latest: "true" },
    });

  const output = environment("GITHUB_OUTPUT");
  appendFileSync(
    output,
    `version=${version}\ntag=${tag}\nurl=${release.html_url}\n`,
  );
  appendFileSync(
    environment("GITHUB_STEP_SUMMARY"),
    `### Release ${tag}\n\n${release.html_url}\n\nCommit \`${sha}\`, verified by ${run.html_url}; ${planned.length} files.\n`,
  );
  console.log(`Published ${release.html_url}.`);
}

main().catch((error) => {
  const message = error instanceof ReleaseError ? error.message : "Release failed before completion.";
  console.log(`::error::${message.replace(/[\r\n%]/g, " ")}`);
  process.exitCode = 1;
});
