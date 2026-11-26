import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { runProjectCommand, runnerFailureClassifier } from "../../lib/project-command.mjs";
import { parseJsonSafe, sanitizeProjectEnv } from "../../lib/step-receipts.mjs";

function runBufferedJust(argv, { cwd, environment, label, tempRoot, index }) {
  const observe = environment.RUNNER_ENVIRONMENT === "self-hosted";
  const partDir = path.join(tempRoot, `part-${index}`);
  const partTmp = path.join(partDir, "tmp");
  const logFile = path.join(partDir, "output.log");
  mkdirSync(partTmp, { recursive: true });
  const env = { ...environment, TMPDIR: partTmp, TEMP: partTmp, TMP: partTmp };
  return new Promise((resolve, reject) => {
    const out = createWriteStream(logFile);
    const child = spawn("just", argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const classify = observe ? runnerFailureClassifier(env) : null;
    let reason = "";
    const tap = (stream) => {
      const decoder = new StringDecoder("utf8");
      let partial = "";
      stream.on("data", (chunk) => {
        out.write(chunk);
        if (!classify) return;
        const lines = (partial + decoder.write(chunk)).split("\n");
        partial = lines.pop().slice(-8192);
        for (const line of lines) {
          reason = classify(line.replace(/\x1b\[[\d;]*m/g, "").slice(-8192)) || reason;
        }
      });
      stream.on("end", () => {
        if (classify && partial) {
          const finalLine = (partial + decoder.end()).replace(/\x1b\[[\d;]*m/g, "").slice(-8192);
          reason = classify(finalLine) || reason;
        }
      });
    };
    tap(child.stdout);
    tap(child.stderr);
    child.on("error", (error) => {
      out.end(() => reject(error));
    });
    child.on("close", (code, signal) => {
      out.end(() => {
        const status = code ?? (signal ? 128 : 1);
        resolve({ index, label, argv, status, reason, logFile, partDir });
      });
    });
  });
}

function printGroupedLog(result) {
  const title = result.label ? `verify: ${result.label}` : `just ${result.argv.join(" ")}`;
  process.stdout.write(`::group::${title}\n`);
  if (existsSync(result.logFile)) {
    const text = readFileSync(result.logFile, "utf8");
    if (text) {
      process.stdout.write(text);
      if (!text.endsWith("\n")) process.stdout.write("\n");
    }
  }
  process.stdout.write("::endgroup::\n");
  if (result.status !== 0) {
    process.stderr.write(`::error::Part \`just ${result.argv.join(" ")}\` exited with ${result.status}.\n`);
  }
}

function logSkipped(step) {
  const argv = Array.isArray(step.argv) ? step.argv.join(" ") : String(step.label ?? "");
  if (step.filteredByPath) {
    console.log(`Skipped \`just ${argv}\` (no changed files matched part-paths).`);
    return;
  }
  console.log(`Reused step receipt for \`just ${argv}\` from run #${step.reusedRunId ?? "?"} (${step.reusedRunUrl ?? ""})`);
}

async function runFallback(environment, cleanEnv, cwd) {
  const output = environment.GITHUB_OUTPUT || "";
  if (environment.SETUP === "true") {
    const code = await runProjectCommand("just", ["setup"], { cwd, environment: cleanEnv, output });
    if (code !== 0) return code;
  }
  const hasExplicitPart = Boolean(environment.PART && environment.PART !== "[]");
  if (environment.EVENT === "pull_request" || (environment.EVENT === "merge_group" && !hasExplicitPart)) {
    const checkCode = await runProjectCommand("just", ["check"], { cwd, environment: cleanEnv, output });
    if (checkCode !== 0) return checkCode;
    const dumped = spawnSync("just", ["--dump", "--dump-format", "json"], {
      cwd, env: cleanEnv, encoding: "utf8", maxBuffer: 64 << 20,
    });
    if (dumped.error || dumped.status !== 0) {
      if (dumped.stderr) process.stderr.write(dumped.stderr);
      return dumped.status ?? 1;
    }
    const parsed = JSON.parse(dumped.stdout);
    const hasTest = Object.hasOwn(parsed.recipes || {}, "test") || Object.hasOwn(parsed.aliases || {}, "test");
    if (hasTest) return runProjectCommand("just", ["test"], { cwd, environment: cleanEnv, output });
    console.log("This repository declares no test recipe.");
    return 0;
  }
  let argv = ["verify"];
  if (environment.PART && environment.PART !== "[]") {
    const parsed = JSON.parse(environment.PART);
    if (Array.isArray(parsed) && parsed.length > 0) argv = parsed.map(String);
  }
  return runProjectCommand("just", argv, { cwd, environment: cleanEnv, output });
}

export async function runSteps(environment = process.env, cwd = process.cwd()) {
  const cleanEnv = sanitizeProjectEnv(environment);
  const planFile = environment.RECEIPT_PLAN || "";
  const resultsFile = environment.RECEIPT_RESULTS || "";
  const output = environment.GITHUB_OUTPUT || "";

  if (!planFile || !existsSync(planFile)) {
    return runFallback(environment, cleanEnv, cwd);
  }

  const planDoc = parseJsonSafe(readFileSync(planFile, "utf8"), null);
  if (!planDoc || !Array.isArray(planDoc.steps)) {
    return runFallback(environment, cleanEnv, cwd);
  }

  if (planDoc.all_skipped) {
    for (const step of planDoc.steps) logSkipped(step);
    return 0;
  }

  if (environment.SETUP === "true") {
    const setupCode = await runProjectCommand("just", ["setup"], { cwd, environment: cleanEnv, output });
    if (setupCode !== 0) return setupCode;
  }

  const parallelParts = Boolean(planDoc.parallelParts);
  const steps = planDoc.steps;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.skip) {
      logSkipped(step);
      continue;
    }

    if (parallelParts && step.parallelSafe) {
      const batch = [];
      let j = i;
      while (j < steps.length) {
        if (steps[j].skip) {
          logSkipped(steps[j]);
          j += 1;
          continue;
        }
        if (!steps[j].parallelSafe) break;
        batch.push({ index: j, step: steps[j] });
        j += 1;
      }
      if (batch.length >= 2) {
        const tempRoot = path.join(environment.RUNNER_TEMP || tmpdir(), `nddev-ci-parts-${process.pid}-${Date.now()}`);
        mkdirSync(tempRoot, { recursive: true });
        try {
          const settled = await Promise.all(
            batch.map(({ index, step: entry }) =>
              runBufferedJust(entry.argv.map(String), {
                cwd, environment: cleanEnv, label: entry.label, tempRoot, index,
              }).then((result) => {
                printGroupedLog(result);
                return result;
              }),
            ),
          );
          let firstFailure = 0;
          let runnerReason = "";
          for (const result of settled) {
            if (result.status === 0) {
              if (resultsFile) appendFileSync(resultsFile, `${result.index}\n`);
            } else {
              if (resultsFile) appendFileSync(resultsFile, `failed:${result.index}:${result.status}\n`);
              if (firstFailure === 0) firstFailure = result.status;
              if (!runnerReason && result.reason) runnerReason = result.reason;
            }
          }
          if (firstFailure !== 0) {
            if (runnerReason && output) appendFileSync(output, `runner-reason=${runnerReason}\n`);
            return firstFailure;
          }
        } finally {
          rmSync(tempRoot, { recursive: true, force: true });
        }
        i = j - 1;
        continue;
      }
    }

    const argv = step.argv.map(String);
    const code = await runProjectCommand("just", argv, { cwd, environment: cleanEnv, output });
    if (code === 0) {
      if (resultsFile) appendFileSync(resultsFile, `${i}\n`);
    } else {
      if (resultsFile) appendFileSync(resultsFile, `failed:${i}:${code}\n`);
      return code;
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runSteps();
}
