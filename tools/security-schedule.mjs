#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { dailySlot, dailyWindow, elapsedSeconds, elapsedTime } from "../lib/security-schedule.mjs";

function api(route) {
  try {
    return JSON.parse(execFileSync("gh", ["api", route], {
      encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch { throw new Error("Could not read the GitHub Actions schedule evidence."); }
}

export function inspect(repository, workflow, cron, anchor, read = api) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[\w.-]+\.ya?ml$/.test(workflow))
    throw new Error("Supply an owner/repository and a workflow file name.");
  const slot = dailySlot(cron, anchor);
  if (slot === null) throw new Error("Supply a fixed daily UTC cron expression.");
  const window = dailyWindow(slot);
  const route = `repos/${repository}/actions`;
  const query = new URLSearchParams({event: "schedule", created: window.join(".."), per_page: "100"});
  const listed = read(`${route}/workflows/${workflow}/runs?${query}`);
  const runs = listed.workflow_runs;
  if (!Array.isArray(runs) || runs.length !== listed.total_count || runs.some((run) => {
    const created = Date.parse(run?.created_at);
    return !Number.isSafeInteger(run?.id) || run.id <= 0 || run.event !== "schedule" ||
      !Number.isFinite(created) || created < slot || created > Date.parse(window[1]);
  })) throw new Error("GitHub returned incomplete schedule evidence.");

  const expected = `Daily security slot ${window[0]}.`;
  if (runs.length === 0) return [expected, "A scheduled run has yet to appear. GitHub may still be delaying it."];
  if (runs.length > 1) return [expected, "Several scheduled runs appeared in this slot. Their intended times are unknown."];
  const [run] = runs;
  const created = Date.parse(run.created_at);
  const delay = elapsedSeconds(slot, created);
  const lines = [expected, delay >= 60
    ? `GitHub created the run late by ${elapsedTime(delay)} at ${run.created_at}.`
    : `GitHub created the run at ${run.created_at}.`];
  const result = read(`${route}/runs/${run.id}/attempts/1/jobs?per_page=100`);
  if (!Array.isArray(result.jobs) || result.jobs.length !== result.total_count)
    throw new Error("GitHub returned incomplete job timing evidence.");
  const first = result.jobs.filter((job) => job.status !== "queued" && job.conclusion !== "skipped")
    .map((job) => Date.parse(job.started_at)).filter((time) => time >= created).sort((a, b) => a - b)[0];
  lines.push(first === undefined ? "The first job has yet to start." :
    `First job started at ${new Date(first).toISOString()}, ${elapsedTime(elapsedSeconds(created, first))} after run creation.`);
  return lines;
}

export function main(argv = process.argv.slice(2)) {
  const {positionals, values} = parseArgs({args: argv, allowPositionals: true,
    options: {cron: {type: "string"}, date: {type: "string"}, workflow: {type: "string", default: "security.yml"}}});
  if (positionals.length !== 1 || !values.cron)
    throw new Error('Usage: node tools/security-schedule.mjs OWNER/REPOSITORY --cron "M H * * *" [--date YYYY-MM-DD] [--workflow FILE]');
  const date = values.date;
  const anchor = date ? new Date(date + "T23:59:59Z") : new Date();
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(anchor.getTime()) ||
      anchor.toISOString().slice(0, 10) !== date)) throw new Error("The date must be a valid YYYY-MM-DD.");
  console.log(inspect(positionals[0], values.workflow, values.cron, anchor).join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
