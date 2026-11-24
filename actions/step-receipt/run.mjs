import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  buildReceiptSession,
  checkIdForArgv,
  computeInputDigest,
  computeToolchainAndRunnerDigests,
  fetchGatewayRunnerInfo,
  formatReceiptSummary,
  isArtifactProducingPart,
  lookupStepInSession,
  makeSummaryEntry,
  parseJsonSafe,
  planMatchesTarget,
  readJustDump,
  recipeClosureDigest,
  summarizeReceiptEntries,
  targetRunnerForPart,
  writeActionOutputs,
  writeReceiptMetadata,
} from "../../lib/step-receipts.mjs";

export async function runSummary(environment = process.env) {
  const input = (name) => (environment[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const reused = parseJsonSafe(input("reused"), []);
  const bypassReason = input("bypass-reason");
  const canary = input("canary") === "true";
  const summary = summarizeReceiptEntries(reused, { bypassReason, canary });
  if (environment.GITHUB_STEP_SUMMARY && (reused.length > 0 || bypassReason || canary)) {
    appendFileSync(environment.GITHUB_STEP_SUMMARY, `${formatReceiptSummary(reused, { bypassReason, canary })}\n`);
  }
  writeReceiptMetadata(environment.RUNNER_TEMP, summary);
  writeActionOutputs(environment.GITHUB_OUTPUT, {
    "receipt-mode": summary.mode,
    "reused-run-id": summary.reusedRunId,
    "bypass-reason": summary.bypassReason,
  });
  return summary;
}

export async function runPlan(environment = process.env, deps = {}) {
  const input = (name) => (environment[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const matrix = parseJsonSafe(input("matrix"), []);
  const split = input("split") === "true";
  const workflowInputs = parseJsonSafe(input("receipt-inputs"), {});
  const emit = (result) => {
    writeReceiptMetadata(environment.RUNNER_TEMP, result);
    writeActionOutputs(environment.GITHUB_OUTPUT, {
      matrix: JSON.stringify(result.matrix),
      "all-reused": String(result.allReused),
      reused: JSON.stringify(result.reused),
      canary: String(result.canary),
      "bypass-reason": result.bypassReason,
      "receipt-mode": result.mode,
      "reused-run-id": result.reusedRunId,
    });
    return result;
  };
  if (!Array.isArray(matrix) || matrix.length === 0 || !environment.NDDEV_CI_RECEIPT_GATEWAY) {
    return emit({ matrix: Array.isArray(matrix) ? matrix : [], allReused: false, reused: [], canary: false, bypassReason: "", mode: "executed", reusedRunId: "" });
  }

  const session = await buildReceiptSession(environment, workflowInputs, { wholeJobArtifact: !split, deps });
  if (session.bypass.bypass || !split || !session.privateRepo || !session.gatewayUrl) {
    if (environment.GITHUB_STEP_SUMMARY && session.bypass.bypass) {
      appendFileSync(environment.GITHUB_STEP_SUMMARY, `\n${formatReceiptSummary([], { bypassReason: session.bypass.reason })}\n`);
    }
    return emit({
      matrix, allReused: false, reused: [], canary: session.canary,
      bypassReason: session.bypass.reason, mode: session.bypass.bypass ? "bypassed" : "executed", reusedRunId: "",
    });
  }

  const dump = (deps.readJustDump ?? readJustDump)(session.cwd);
  if (!dump) {
    return emit({ matrix, allReused: false, reused: [], canary: session.canary, bypassReason: "justfile-unreadable", mode: "bypassed", reusedRunId: "" });
  }

  const partRunners = parseJsonSafe(workflowInputs["part-runners"], {});
  const setup = workflowInputs.setup === true || workflowInputs.setup === "true";
  const remoteDigests = new Map();
  const resolveTargetDigests = async (target) => {
    if (planMatchesTarget(environment, target)) {
      return { matched: true, runnerDigest: session.runnerDigest, toolchainDigest: session.toolchainDigest };
    }
    if (target.environment !== "self-hosted" || !target.profile) return { matched: false };
    if (!remoteDigests.has(target.profile)) {
      const info = await (deps.fetchGatewayRunnerInfo ?? fetchGatewayRunnerInfo)({
        gatewayUrl: session.gatewayUrl, profile: target.profile, fetchImpl: deps.fetchImpl,
      });
      if (info && (!target.os || info.os === target.os) && (!target.arch || info.arch === target.arch)) {
        const targetEnv = {
          RUNNER_ENVIRONMENT: "self-hosted",
          RUNNER_OS: info.os,
          RUNNER_ARCH: info.arch,
          NDDEV_CI_RUNNER_PROFILE: info.profile,
          NDDEV_CI_SDK_LOCK_SHA256: info.sdkLockSha256,
        };
        const digests = (deps.computeToolchainAndRunnerDigests ?? computeToolchainAndRunnerDigests)(
          targetEnv, workflowInputs, { probedOverride: { just: info.justVersion } },
        );
        remoteDigests.set(target.profile, { matched: true, ...digests });
      } else {
        remoteDigests.set(target.profile, { matched: false });
      }
    }
    return remoteDigests.get(target.profile);
  };
  const runnable = [];
  const reused = [];
  const summaryEntries = [];

  for (const part of matrix) {
    const target = targetRunnerForPart({
      privateRepo: session.privateRepo,
      runner: workflowInputs.runner || "nddev-linux-standart",
      runnerProfile: workflowInputs["runner-profile"] || "",
      hostedRunner: workflowInputs["hosted-runner"] || "ubuntu-24.04",
      partRunners,
      partGroup: part.group,
    });
    const resolved = await resolveTargetDigests(target);
    const matchesTarget = resolved.matched;
    const producesArtifact = session.artifact !== "" && isArtifactProducingPart(part);
    const checkId = checkIdForArgv(part.argv);
    const inputDigest = computeInputDigest({
      cacheEpoch: session.cacheEpoch, workflowSha: session.workflowSha, checkId,
      treeSha: session.treeSha, lockfilesDigest: session.lockfilesDigest,
      recipeDigest: recipeClosureDigest(dump, part.argv, { setup }),
      toolchainDigest: matchesTarget ? resolved.toolchainDigest : session.toolchainDigest,
      runnerDigest: matchesTarget ? resolved.runnerDigest : session.runnerDigest,
    });
    const base = { label: part.label, checkId, treeSha: session.treeSha, inputDigest };

    if (!matchesTarget || producesArtifact) {
      runnable.push(part);
      summaryEntries.push(makeSummaryEntry(base, {
        outcome: producesArtifact ? "executed (artifact)" : "scheduled (target runner checks receipt)",
      }));
      continue;
    }

    const lookup = await lookupStepInSession(session, { checkId, inputDigest }, deps);
    if (lookup.hit && !session.canary) {
      const entry = {
        ...makeSummaryEntry(base, {
          outcome: "reused (pass)", reused: true,
          reusedRunId: String(lookup.receipt.run_id ?? ""),
          reusedRunUrl: String(lookup.receipt.run_url ?? ""),
          reusedEvent: String(lookup.receipt.event_name ?? ""),
        }),
        argv: part.argv,
      };
      reused.push(entry);
      summaryEntries.push(entry);
    } else {
      runnable.push(part);
      summaryEntries.push(makeSummaryEntry(base, {
        outcome: lookup.hit && session.canary ? "canary (re-executing fresh)" : "scheduled (cache miss)",
        reusedRunId: lookup.hit ? String(lookup.receipt.run_id ?? "") : "",
        reusedRunUrl: lookup.hit ? String(lookup.receipt.run_url ?? "") : "",
        reusedEvent: lookup.hit ? String(lookup.receipt.event_name ?? "") : "",
      }));
    }
  }

  if (runnable.length === 0 && session.artifact !== "" && matrix.length > 0) {
    const keep = matrix.at(-1);
    runnable.push(keep);
    const idx = reused.findIndex((item) => item.label === keep.label);
    if (idx >= 0) reused.splice(idx, 1);
  }

  const allReused = runnable.length === 0 && reused.length > 0;
  const stats = summarizeReceiptEntries(summaryEntries, { bypassReason: "", canary: session.canary });
  if (environment.GITHUB_STEP_SUMMARY && summaryEntries.length > 0) {
    appendFileSync(environment.GITHUB_STEP_SUMMARY, `\n${formatReceiptSummary(summaryEntries, { canary: session.canary })}\n`);
  }
  console.log(`Step receipts: ${reused.length} reused, ${runnable.length} to run${session.canary ? " (canary run)" : ""}.`);
  return emit({ matrix: runnable, allReused, reused, canary: session.canary, bypassReason: "", mode: stats.mode, reusedRunId: stats.reusedRunId });
}

export async function main(environment = process.env, deps = {}) {
  const mode = (environment.INPUT_MODE ?? "").trim();
  if (mode === "plan") return runPlan(environment, deps);
  if (mode === "summary") return runSummary(environment);
  throw new Error("mode must be plan or summary.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error.message.replace(/[\r\n%]/g, " ")}`);
    process.exitCode = 1;
  });
}
