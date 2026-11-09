// Writes a job's summary and its structured record. The record uses OpenTelemetry's CI/CD and
// VCS attribute names; it holds no secret, token, path of a credential or command output.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const results = { success: "success", failure: "failure", cancelled: "cancellation" };

export function sccache(text) {
  const stats = {};
  for (const [name, key] of [
    ["Compile requests", "requests"],
    ["Cache hits", "hits"],
    ["Cache misses", "misses"],
    ["Cache read errors", "read_errors"],
    ["Cache write errors", "write_errors"],
  ]) {
    const match = new RegExp(`^${name}\\s+(\\d+)\\s*$`, "m").exec(text ?? "");
    if (match) stats[key] = Number(match[1]);
  }
  return stats;
}

export function record(environment, now = new Date()) {
  const input = (name) => (environment[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const status = input("status");
  if (!Object.hasOwn(results, status)) throw new Error("status must be success, failure or cancelled");
  const type = input("task-type") || "test";
  if (!["build", "test", "deploy"].includes(type)) throw new Error("task-type must be build, test or deploy");
  const task = input("task");
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,79}$/.test(task)) throw new Error("task must be a short plain name");
  const server = environment.GITHUB_SERVER_URL ?? "https://github.com";
  const repository = environment.GITHUB_REPOSITORY ?? "";
  const run = environment.GITHUB_RUN_ID ?? "";
  const document = {
    timestamp: now.toISOString(),
    severity: status === "success" ? "INFO" : "ERROR",
    "event.name": "nddev_ci.job.completed",
    "service.name": "nddev-ci",
    "cicd.pipeline.name": environment.GITHUB_WORKFLOW ?? "",
    "cicd.pipeline.run.id": run,
    "cicd.pipeline.run.url.full": `${server}/${repository}/actions/runs/${run}`,
    "cicd.pipeline.task.name": task,
    "cicd.pipeline.task.type": type,
    "cicd.pipeline.task.run.id": environment.GITHUB_JOB ?? "",
    "cicd.pipeline.task.run.result": results[status],
    "cicd.worker.name": environment.RUNNER_NAME ?? "",
    "vcs.repository.url.full": `${server}/${repository}`,
    "vcs.ref.head.name": environment.GITHUB_HEAD_REF || environment.GITHUB_REF_NAME || "",
    "vcs.ref.head.revision": environment.GITHUB_SHA ?? "",
    "nddev_ci.event": environment.GITHUB_EVENT_NAME ?? "",
    "nddev_ci.run_attempt": Number(environment.GITHUB_RUN_ATTEMPT ?? 0),
    "nddev_ci.runner.environment": environment.RUNNER_ENVIRONMENT ?? "",
    "os.type": { Linux: "linux", macOS: "darwin", Windows: "windows" }[environment.RUNNER_OS] ?? "",
    "host.arch": { X64: "amd64", ARM64: "arm64" }[environment.RUNNER_ARCH] ?? os.arch(),
  };
  const started = input("started-file");
  const queued = input("queue-seconds") || environment.NDDEV_CI_QUEUE_SECONDS || "";
  if (queued !== "") {
    if (!/^\d+(?:\.\d+)?$/.test(queued) || !Number.isFinite(Number(queued)))
      throw new Error("queue-seconds must be a measured nonnegative number");
    document["nddev_ci.queue_seconds"] = Number(queued);
  }
  if (started && existsSync(started)) {
    const seconds = Number(readFileSync(started, "utf8").trim());
    if (Number.isSafeInteger(seconds) && seconds > 0)
      document["nddev_ci.duration_seconds"] = Math.max(0, Math.round(now.getTime() / 1000) - seconds);
  }
  const wrapper = environment.RUSTC_WRAPPER;
  if (wrapper && path.basename(wrapper).startsWith("sccache") && existsSync(wrapper)) {
    const stats = spawnSync(wrapper, ["--show-stats"], { encoding: "utf8", timeout: 30000 });
    if (!stats.error && stats.status === 0)
      for (const [key, value] of Object.entries(sccache(stats.stdout)))
        document[`nddev_ci.sccache.${key}`] = value;
  }
  document.message = `${task} ${results[status]}`;
  return document;
}

export function main(environment = process.env) {
  const document = record(environment);
  const line = JSON.stringify(document);
  console.log(line);
  const seconds = document["nddev_ci.duration_seconds"];
  const queue = document["nddev_ci.queue_seconds"];
  const cache = Object.entries(document).filter(([key]) => key.startsWith("nddev_ci.sccache."))
    .map(([key, value]) => `${key.slice("nddev_ci.sccache.".length)} ${value}`).join(", ");
  if (environment.GITHUB_STEP_SUMMARY)
    appendFileSync(environment.GITHUB_STEP_SUMMARY, [
      `### ${document["cicd.pipeline.task.name"]}: ${document["cicd.pipeline.task.run.result"]}`, "",
      "| Runner | System | Queue | Duration | Compiler cache |", "| --- | --- | --- | --- | --- |",
      `| ${document["cicd.worker.name"]} (${document["nddev_ci.runner.environment"]}) | ${document["os.type"]} ${document["host.arch"]} | ${queue === undefined ? "unknown" : `${queue}s`} | ${seconds === undefined ? "unknown" : `${Math.floor(seconds / 60)}m ${seconds % 60}s`} | ${cache || "none"} |`,
      "",
    ].join("\n"));
  // Our runners name a telemetry file the contour collects; GitHub's runners leave this unset.
  const sink = environment.NDDEV_CI_TELEMETRY_FILE ?? "";
  if (sink) {
    if (!path.isAbsolute(sink) || (existsSync(sink) && !lstatSync(sink).isFile()))
      throw new Error("NDDEV_CI_TELEMETRY_FILE must name a regular file by its absolute path");
    appendFileSync(sink, `${line}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try { main(); }
  catch (error) {
    console.log(`::error::Job record: ${error.message}`);
    process.exitCode = 1;
  }
