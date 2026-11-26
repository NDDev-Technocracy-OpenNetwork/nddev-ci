import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The merge stop's own script, run directly as actions/merge-stops runs it.
const scriptPath = fileURLToPath(new URL("../actions/merge-stops/pr-text.py", import.meta.url));

const TERMS = `[terms."pull request"]
avoid = ["PR", "PRs"]

[terms."repository"]
avoid = ["repo", "repos"]

[machine]
words = ["robust"]
phrases = ["in order to"]
`;

function check(t, request) {
  const root = mkdtempSync(join(tmpdir(), "nddev-ci-pr-text-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "terms.toml"), TERMS);
  writeFileSync(join(root, "event.json"), JSON.stringify({ pull_request: request }));
  return spawnSync("python3", ["-I", scriptPath], {
    env: {
      PATH: process.env.PATH,
      GITHUB_EVENT_PATH: join(root, "event.json"),
      NDDEV_CI_TERMS: pathToFileURL(join(root, "terms.toml")).href,
    },
    encoding: "utf8",
  });
}

const person = { login: "rldyourmnd", type: "User" };

test("a title and description in the standards' terms pass", (t) => {
  const result = check(t, {
    user: person,
    title: "fix(ci): keep the pull request's reports",
    body: "The repository keeps `PR` and \"repo\" as mentions.\n\n```\nPR repo\n```\n[link](https://github.com/o/repos/pull/1) https://api.github.com/repos/x <!-- PR -->",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("an avoided word or machine phrase warns, names the term to write and passes", (t) => {
  const result = check(t, {
    user: person,
    title: "fix: this PR is robust",
    body: "Open the repo in order to check.",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /::warning::title:1: write "pull request" instead of "PR"/);
  assert.match(result.stdout, /::warning::title:1: "robust" reads as machine text/);
  assert.match(result.stdout, /::warning::description:1: write "repository" instead of "repo"/);
  assert.match(result.stdout, /::warning::description:1: "in order to" reads as machine text/);
});

test("words match whole and in any case, and an empty description passes", (t) => {
  assert.match(check(t, { user: person, title: "feat: Repository and prs", body: null }).stdout, /::warning::title:1: write "pull request" instead of "prs"/);
  assert.doesNotMatch(check(t, { user: person, title: "feat: express a prefix", body: null }).stdout, /::warning::/);
});

test("a runner without the terms says so and passes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nddev-ci-pr-text-none-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "event.json"), JSON.stringify({ pull_request: { user: person, title: "fix: PR", body: "" } }));
  const result = spawnSync("python3", ["-I", scriptPath], {
    env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: join(root, "event.json") },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /::notice::this runner holds no registry\/terms\.toml/);
});

test("the terms may be a plain file path", (t) => {
  const root = mkdtempSync(join(tmpdir(), "nddev-ci-pr-text-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "terms.toml"), TERMS);
  writeFileSync(join(root, "event.json"), JSON.stringify({ pull_request: { user: person, title: "fix: PR", body: "" } }));
  const result = spawnSync("python3", ["-I", scriptPath], {
    env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: join(root, "event.json"), NDDEV_CI_TERMS: join(root, "terms.toml") },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /::warning::title:1:/);
});

test("a bot's pull request passes", (t) => {
  const result = check(t, {
    user: { login: "dependabot[bot]", type: "Bot" },
    title: "chore(deps): bump the repo PR",
    body: "Dependabot will rebase this PR",
  });
  assert.equal(result.status, 0);
});
