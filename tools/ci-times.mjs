import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { client } from "../lib/qualification.mjs";

// How long a repository's checks make an agent wait: for each check, the time from the event to the
// check's result, the longest wait of one job for a runner and the longest job, over its newest
// completed runs. The result job is the one named "short check" or "full check", so a full check
// split into parts is measured to its joined result.
const refuse = (message) => { throw new Error(message); };
const result = /(^|\/ )(short|full) check$/;
const seconds = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;

/** The nearest-rank percentile: the smallest value at or above the given share of the values. */
export function percentile(values, share) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)];
}

/** One run's measures from its latest attempt's jobs; null when it has no finished result. */
export function measure(run, jobs) {
  const finished = jobs.filter((job) => job.started_at && job.completed_at && job.conclusion !== "skipped");
  const answer = finished.filter((job) => result.test(job.name) && ["success", "failure"].includes(job.conclusion));
  if (answer.length !== 1) return null;
  const [job] = answer;
  return {
    check: job.name.endsWith("full check") ? "full check" : "short check",
    conclusion: job.conclusion,
    answer: seconds(run.created_at, job.completed_at),
    wait: Math.max(...finished.map((each) => seconds(each.created_at, each.started_at))),
    longest: Math.max(...finished.map((each) => seconds(each.started_at, each.completed_at))),
    jobs: finished.length,
  };
}

/** Median, 90th percentile and maximum of each measure, in minutes, per check. */
export function summarize(measures) {
  const minutes = (value) => value === undefined ? "-" : (value / 60).toFixed(1);
  const triple = (values) => [0.5, 0.9, 1].map((share) => minutes(percentile(values, share))).join(" / ");
  return ["short check", "full check"].map((check) => {
    const rows = measures.filter((row) => row.check === check);
    return {
      check, runs: rows.length, failed: rows.filter((row) => row.conclusion === "failure").length,
      answer: triple(rows.map((row) => row.answer)), wait: triple(rows.map((row) => row.wait)),
      longest: triple(rows.map((row) => row.longest)),
      jobs: rows.length ? Math.max(...rows.map((row) => row.jobs)) : 0,
    };
  }).filter((row) => row.runs);
}

export function table(repository, summary) {
  const lines = ["| Repository | Check | Runs (red) | Answer: median / p90 / max | Longest wait for a runner | Longest job | Jobs |",
    "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of summary)
    lines.push(`| ${repository} | ${row.check} | ${row.runs} (${row.failed}) | ${row.answer} | ${row.wait} | ${row.longest} | ${row.jobs} |`);
  return lines.join("\n");
}

async function runs(github, repository, workflow, query, count) {
  const found = [];
  for (let page = 1; found.length < count && page <= 10; page++) {
    const listed = await github.json("GET",
      `/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?status=completed&per_page=100&page=${page}&${query}`);
    if (!Array.isArray(listed?.workflow_runs)) refuse("The run inventory is malformed.");
    found.push(...listed.workflow_runs.filter((run) => !["cancelled", "skipped"].includes(run.conclusion)));
    if (listed.workflow_runs.length < 100) break;
  }
  return found.slice(0, count);
}

async function jobs(github, repository, run) {
  const listed = await github.json("GET", `/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  if (!Array.isArray(listed?.jobs)) refuse("The job inventory is malformed.");
  return listed.jobs;
}

async function main() {
  const [repository, ...rest] = process.argv.slice(2);
  const options = {workflow: "ci.yml", branch: "dev", runs: "30"};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]?.replace(/^--/, "");
    if (!(name in options) || rest[index + 1] === undefined) refuse("Usage: ci-times.mjs owner/repository [--workflow ci.yml] [--branch dev] [--runs 30]");
    options[name] = rest[index + 1];
  }
  const count = Number(options.runs);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !Number.isSafeInteger(count) || count < 1 || count > 200 ||
      !/^[A-Za-z0-9._-]+\.ya?ml$/.test(options.workflow) || !/^[A-Za-z0-9._/-]+$/.test(options.branch))
    refuse("Usage: ci-times.mjs owner/repository [--workflow ci.yml] [--branch dev] [--runs 30]");
  const token = process.env.GH_TOKEN || execFileSync("gh", ["auth", "token"], {stdio: ["ignore", "pipe", "pipe"], encoding: "utf8"}).trim();
  const github = client(token);
  const selected = [
    ...await runs(github, repository, options.workflow, "event=pull_request", count),
    ...await runs(github, repository, options.workflow, `event=push&branch=${encodeURIComponent(options.branch)}`, count),
  ];
  const measures = [];
  for (const run of selected) {
    const row = measure(run, await jobs(github, repository, run));
    if (row) measures.push(row);
  }
  console.log(table(repository, summarize(measures)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => { console.error(error.message.replace(/[\r\n]/g, " ")); process.exitCode = 1; });
