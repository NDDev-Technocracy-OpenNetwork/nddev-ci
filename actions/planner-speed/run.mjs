import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const policyPath = ".nddev-ci-planner-speed.json";
const plannerPath = "lib/verify-parts.mjs";
const runs = 5;
const plansPerRun = 20_000;
const oid = /^[0-9a-f]{40}$/;

const input = {
  recipes: {
    verify: {
      priors: 3,
      dependencies: ["check", "test", "package-tools"].map((recipe) => ({recipe})),
    },
    check: {},
    test: {dependencies: [{recipe: "setup"}]},
    "package-tools": {},
    setup: {},
  },
};

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    env: {...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0"},
  });
}

const median = (samples) => [...samples].sort((a, b) => a - b)[Math.floor(runs / 2)];

export function compareTiming(baseSamples, mergeSamples, margin) {
  if ([baseSamples, mergeSamples].some((samples) =>
    samples.length !== runs || samples.some((sample) => !Number.isFinite(sample) || sample <= 0))) {
    throw new Error("The planner benchmark needs five positive timings per source.");
  }
  const base = median(baseSamples);
  const merge = median(mergeSamples);
  return {base, merge, slower: (merge - base) * 100 > base * margin};
}

function cpuTime(plan, count) {
  const started = process.cpuUsage();
  for (let i = 0; i < count; i++) plan(input);
  const {user, system} = process.cpuUsage(started);
  return user + system;
}

function measure(file) {
  const result = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--sample", file], {
    encoding: "utf8",
    env: {PATH: process.env.PATH, LANG: "C"},
    maxBuffer: 1024,
    timeout: 15_000,
  }).trim();
  if (!/^\d+$/.test(result)) throw new Error("The planner worker returned an invalid timing.");
  return Number(result);
}

export async function main({INPUT_BASE: base, INPUT_MERGE: merge} = process.env) {
  if (!oid.test(base ?? "") || !oid.test(merge ?? "")) throw new Error("Expected exact Git commits.");
  // Only the base can opt in or select the margin.
  if (!git("ls-tree", "--name-only", base, "--", policyPath).trim()) return 0;
  if (git("rev-parse", "HEAD").trim() !== merge || git("rev-parse", merge + "^1").trim() !== base) {
    throw new Error("The checked merge does not use the pull request base.");
  }
  const {maxSlowdownPercent: margin} = JSON.parse(git("cat-file", "blob", base + ":" + policyPath));
  if (!Number.isFinite(margin) || margin < 0 || margin > 100) {
    throw new Error(policyPath + " needs a maxSlowdownPercent between 0 and 100.");
  }

  const directory = mkdtempSync(path.join(tmpdir(), "nddev-ci-planner-speed-"));
  try {
    const files = [base, merge].map((commit, index) => {
      const file = path.join(directory, index + ".mjs");
      writeFileSync(file, git("cat-file", "blob", commit + ":" + plannerPath));
      return file;
    });
    const samples = [[], []];
    for (let run = 0; run < runs; run++) {
      // Alternate which source runs first to limit order effects on the same runner.
      for (const index of [run % 2, 1 - run % 2]) {
        samples[index].push(measure(files[index]));
      }
    }
    const result = compareTiming(samples[0], samples[1], margin);
    console.log(`Planner median of ${runs} runs. Base ${result.base} µs, merge ${result.merge} µs, margin ${margin}%.`);
    if (result.slower) {
      console.error("The planner exceeds the permitted slowdown against the pull request base.");
      return 1;
    }
    return 0;
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv[2] === "--sample") {
      const {plan} = await import(pathToFileURL(process.argv[3]).href);
      cpuTime(plan, plansPerRun);
      console.log(cpuTime(plan, plansPerRun));
    } else {
      process.exitCode = await main();
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
