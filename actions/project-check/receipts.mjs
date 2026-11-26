import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildReceiptSession,
  checkIdForArgv,
  computeInputDigest,
  fetchOidcToken,
  formatReceiptSummary,
  inspectVerifyDecomposition,
  isArtifactProducingPart,
  issueStepInSession,
  lookupStepInSession,
  makeSummaryEntry,
  parseJsonSafe,
  readJustDump,
  recipeClosureDigest,
  summarizeReceiptEntries,
  writeActionOutputs,
  writeReceiptMetadata,
} from "../../lib/step-receipts.mjs";
import { parsePartPaths, selectActiveParts } from "../../lib/part-paths.mjs";
import { plan as planVerifyParts } from "../../lib/verify-parts.mjs";

function isShortEvent(eventName, workflowInputs) {
  if (eventName === "pull_request") return true;
  if (eventName === "merge_group") {
    return workflowInputs["merge-group-full-check"] !== true &&
      String(workflowInputs["merge-group-full-check"] ?? "false") !== "true";
  }
  return false;
}

function buildSteps(dump, eventName, partRaw, artifact, workflowInputs = {}) {
  if (isShortEvent(eventName, workflowInputs)) {
    const steps = [{ label: "check", group: "check", argv: ["check"], parallelSafe: false, canSkip: true, canIssue: true }];
    if (dump && ((dump.recipes && Object.hasOwn(dump.recipes, "test")) || (dump.aliases && Object.hasOwn(dump.aliases, "test")))) {
      steps.push({ label: "test", group: "test", argv: ["test"], parallelSafe: false, canSkip: true, canIssue: true });
    }
    return steps;
  }
  const part = parseJsonSafe(partRaw, []);
  if (Array.isArray(part) && part.length > 0 && !(part.length === 1 && part[0] === "verify")) {
    return [{
      label: part.join(" "), group: String(part[0]), argv: part.map(String), parallelSafe: false,
      canSkip: !(artifact && isArtifactProducingPart({ argv: part, group: part[0] })), canIssue: true,
    }];
  }
  const grouped = dump ? planVerifyParts(dump) : { split: false, parts: [] };
  if (grouped.split && grouped.parts.length >= 2) {
    return grouped.parts.map((entry) => ({
      label: entry.name, group: entry.group, argv: entry.argv, parallelSafe: entry.group !== "check",
      canSkip: !(artifact && isArtifactProducingPart(entry)), canIssue: true,
    }));
  }
  const decomposed = inspectVerifyDecomposition(dump);
  if (decomposed.canDecompose && decomposed.priors.length > 0) {
    const steps = decomposed.priors.map((prior) => ({
      label: prior.argv.join(" "), group: prior.key, argv: prior.argv, needs: prior.needs, parallelSafe: false,
      canSkip: !(artifact && isArtifactProducingPart({ argv: prior.argv, group: prior.key })), canIssue: true,
    }));
    if (decomposed.hasBody) steps.push({ label: "verify (body)", group: "verify", argv: ["--no-deps", "verify"], parallelSafe: false, canSkip: false, canIssue: false });
    return steps;
  }
  return [{ label: "verify", group: "verify", argv: ["verify"], parallelSafe: false, canSkip: !artifact, canIssue: true }];
}

export async function prepare(environment = process.env, deps = {}) {
  const cwd = environment.GITHUB_WORKSPACE || process.cwd();
  const tempDir = environment.RUNNER_TEMP || cwd;
  const workflowInputs = parseJsonSafe(environment.RECEIPT_INPUTS, {});
  const setup = environment.SETUP === "true" || workflowInputs.setup === true || workflowInputs.setup === "true";
  const partPaths = parsePartPaths(workflowInputs["part-paths"]);
  const parallelParts = workflowInputs["parallel-parts"] === true || workflowInputs["parallel-parts"] === "true";
  const plansParts = parallelParts || Object.keys(partPaths).length > 0;
  const dump = plansParts || environment.NDDEV_CI_RECEIPT_GATEWAY
    ? (deps.readJustDump ?? readJustDump)(cwd)
    : null;
  if (!dump) {
    writeActionOutputs(environment.GITHUB_OUTPUT, { "plan-file": "", "results-file": "" });
    return null;
  }

  const eventName = environment.EVENT || environment.GITHUB_EVENT_NAME || "";
  const artifact = String(workflowInputs.artifact ?? "").trim();
  const steps = buildSteps(dump, eventName, environment.PART || "", artifact, workflowInputs);
  const session = await buildReceiptSession(environment, { ...workflowInputs, setup }, {
    wholeJobArtifact: steps.length === 1 && artifact !== "",
    deps,
  });

  const filteredOut = new Set();
  if (!isShortEvent(eventName, workflowInputs) && steps.length >= 2 && Object.keys(partPaths).length > 0) {
    const selected = selectActiveParts({
      parts: steps,
      changedFiles: session.changedFiles,
      partPaths,
      ref: session.ref,
      artifact,
    });
    for (const skipped of selected.skippedParts) filteredOut.add(skipped);
  }

  const plannedSteps = [];
  for (const step of steps) {
    const checkId = checkIdForArgv(step.argv);
    const inputDigest = session.workflowSha && session.treeSha
      ? computeInputDigest({
        cacheEpoch: session.cacheEpoch, workflowSha: session.workflowSha, checkId,
        treeSha: session.treeSha, lockfilesDigest: session.lockfilesDigest,
        recipeDigest: recipeClosureDigest(dump, step.argv, { setup }),
        toolchainDigest: session.toolchainDigest, runnerDigest: session.runnerDigest,
      })
      : "";
    const filteredByPath = filteredOut.has(step);
    const entry = {
      label: step.label, group: step.group, argv: step.argv, checkId,
      parallelSafe: Boolean(step.parallelSafe), canSkip: step.canSkip,
      canIssue: step.canIssue && session.eventName === "pull_request" && !session.bypass.bypass && Boolean(inputDigest),
      inputDigest, skip: filteredByPath, filteredByPath, reused: false, cachedHit: false,
      reusedRunId: "", reusedRunUrl: "", reusedEvent: "",
    };
    if (!filteredByPath && step.canSkip) {
      const lookup = await lookupStepInSession(session, { checkId, inputDigest }, deps);
      if (lookup.hit) {
        entry.cachedHit = true;
        entry.reusedRunId = String(lookup.receipt.run_id ?? "");
        entry.reusedRunUrl = String(lookup.receipt.run_url ?? "");
        entry.reusedEvent = String(lookup.receipt.event_name ?? "");
        if (!session.canary) { entry.skip = true; entry.reused = true; }
      }
    }
    plannedSteps.push(entry);
  }

  if (artifact !== "" && plannedSteps.length > 0 && plannedSteps.every((s) => s.skip)) {
    const last = plannedSteps.at(-1);
    last.skip = false;
    last.reused = false;
  }

  const planFile = path.join(tempDir, "nddev-ci-receipt-plan.json");
  const resultsFile = path.join(tempDir, "nddev-ci-receipt-results.txt");
  writeFileSync(resultsFile, "");
  const planDoc = {
    ...session,
    bypassReason: session.bypass.reason,
    bypassFlag: session.bypass.bypass,
    parallelParts,
    all_skipped: plannedSteps.length > 0 && plannedSteps.every((s) => s.skip),
    steps: plannedSteps,
  };
  writeFileSync(planFile, JSON.stringify(planDoc, null, 2));
  writeActionOutputs(environment.GITHUB_OUTPUT, {
    "plan-file": planFile,
    "results-file": resultsFile,
  });
  return planDoc;
}

export async function finish(environment = process.env, deps = {}) {
  const planFile = environment.RECEIPT_PLAN || "";
  const resultsFile = environment.RECEIPT_RESULTS || "";
  const runnerReason = (environment.RUNNER_REASON || "").trim();
  if (!planFile || !existsSync(planFile)) {
    writeActionOutputs(environment.GITHUB_OUTPUT, {
      "receipt-mode": "executed", "reused-run-id": "", "bypass-reason": "",
      "canary-result": "",
    });
    return null;
  }

  const planDoc = JSON.parse(readFileSync(planFile, "utf8"));
  const passed = new Set();
  const failed = new Set();
  if (resultsFile && existsSync(resultsFile)) {
    for (const line of readFileSync(resultsFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (line.startsWith("failed:")) failed.add(Number(line.split(":")[1]));
      else passed.add(Number(line));
    }
  }

  const needsGateway = planDoc.privateRepo && planDoc.gatewayUrl && planDoc.steps.some((s, i) => s.canIssue && passed.has(i));
  const oidc = needsGateway
    ? await (deps.fetchOidcToken ?? fetchOidcToken)(environment, environment.NDDEV_CI_RECEIPT_AUDIENCE || undefined, deps.fetchImpl)
    : null;

  const summaryEntries = [];

  for (let i = 0; i < planDoc.steps.length; i++) {
    const step = planDoc.steps[i];
    const base = { ...step, treeSha: planDoc.treeSha };
    if (step.skip) {
      summaryEntries.push(makeSummaryEntry(base, step.filteredByPath
        ? { outcome: "skipped (path filter)", reused: false }
        : { outcome: "reused (pass)", reused: true }));
      continue;
    }
    if (failed.has(i)) {
      const mismatch = planDoc.canary && step.cachedHit && !runnerReason;
      if (mismatch) {
        console.error(`::error::Canary re-execution failed for "${step.label}" despite cached green receipt from run #${step.reusedRunId}; inspect receipt inputs or bump CACHE_EPOCH.`);
      }
      summaryEntries.push(makeSummaryEntry(base, {
        outcome: mismatch ? "canary MISMATCH (fail vs cached pass)" : "executed (fail)",
        canaryResult: mismatch ? "mismatch" : "",
      }));
      continue;
    }
    if (!passed.has(i)) continue;
    const matched = planDoc.canary && step.cachedHit;
    const outcome = matched ? "canary match (pass)" : (planDoc.bypassFlag ? `bypassed (${planDoc.bypassReason})` : "executed (pass)");
    if (step.canIssue) {
      if (planDoc.privateRepo && planDoc.gatewayUrl && oidc?.token) {
        const res = await issueStepInSession(planDoc, step, oidc.token, deps);
        if (!res.issued) console.log(`::notice::Step receipt was not stored for "${step.label}" (${res.reason}).`);
      }
    }
    summaryEntries.push(makeSummaryEntry(base, { outcome, canaryResult: matched ? "match" : "" }));
  }

  const stats = summarizeReceiptEntries(summaryEntries, { bypassReason: planDoc.bypassReason, canary: planDoc.canary });
  if (environment.GITHUB_STEP_SUMMARY && (summaryEntries.length > 0 || planDoc.bypassReason)) {
    appendFileSync(environment.GITHUB_STEP_SUMMARY, `\n${formatReceiptSummary(summaryEntries, { bypassReason: planDoc.bypassReason, canary: planDoc.canary })}\n`);
  }
  writeReceiptMetadata(environment.RUNNER_TEMP, stats);
  writeActionOutputs(environment.GITHUB_OUTPUT, {
    "receipt-mode": stats.mode, "reused-run-id": stats.reusedRunId,
    "bypass-reason": stats.bypassReason, "canary-result": stats.canaryResult,
  });
  return { stats, summaryEntries };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const modes = { prepare, finish };
  const fn = modes[process.argv[2] || ""];
  if (!fn) { console.error("::error::receipts mode must be prepare or finish"); process.exitCode = 1; }
  else Promise.resolve(fn()).catch((error) => { console.error(`::error::${error.message.replace(/[\r\n%]/g, " ")}`); process.exitCode = 1; });
}
