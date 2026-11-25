import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildPublicReceiptStatement,
  buildReceiptSession,
  checkIdForArgv,
  computeInputDigest,
  fetchOidcToken,
  formatReceiptSummary,
  inspectVerifyDecomposition,
  isArtifactProducingPart,
  isReleaseRef,
  issueStepInSession,
  lookupStepInSession,
  makeSummaryEntry,
  parseJsonSafe,
  publicCacheKey,
  readJustDump,
  recipeClosureDigest,
  sha256Hex,
  summarizeReceiptEntries,
  verifyReceiptStatement,
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
  const dump = (deps.readJustDump ?? readJustDump)(cwd);
  if (!dump) {
    writeActionOutputs(environment.GITHUB_OUTPUT, { "plan-file": "", "results-file": "", "public-cache-key": "", "public-cache-path": "" });
    return null;
  }

  const eventName = environment.EVENT || environment.GITHUB_EVENT_NAME || "";
  const artifact = String(workflowInputs.artifact ?? "").trim();
  const steps = buildSteps(dump, eventName, environment.PART || "", artifact, workflowInputs);
  const session = await buildReceiptSession(environment, { ...workflowInputs, setup }, {
    wholeJobArtifact: steps.length === 1 && artifact !== "",
    deps,
  });

  const partPaths = parsePartPaths(workflowInputs["part-paths"]);
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
      canIssue: step.canIssue && !isReleaseRef(session.ref) && !session.dirty && Boolean(inputDigest),
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

  const jobDigest = sha256Hex(plannedSteps.map((s) => `${s.checkId}:${s.inputDigest}`).join("\n"));
  const publicCacheDir = path.join(tempDir, "nddev-ci-receipts", jobDigest.slice(0, 24));
  const publicKey = (!session.privateRepo && !session.dirty && session.workflowSha && session.treeSha)
    ? publicCacheKey({ cacheEpoch: session.cacheEpoch, inputDigest: jobDigest, checkId: eventName === "pull_request" ? "short" : "check" })
    : "";

  const planFile = path.join(tempDir, "nddev-ci-receipt-plan.json");
  const resultsFile = path.join(tempDir, "nddev-ci-receipt-results.txt");
  writeFileSync(resultsFile, "");
  const parallelParts = workflowInputs["parallel-parts"] === true || workflowInputs["parallel-parts"] === "true";
  const planDoc = {
    ...session,
    bypassReason: session.bypass.reason,
    bypassFlag: session.bypass.bypass,
    parallelParts,
    publicCacheDir,
    publicKey,
    all_skipped: plannedSteps.length > 0 && plannedSteps.every((s) => s.skip),
    steps: plannedSteps,
  };
  writeFileSync(planFile, JSON.stringify(planDoc, null, 2));
  writeActionOutputs(environment.GITHUB_OUTPUT, {
    "plan-file": planFile,
    "results-file": resultsFile,
    "public-cache-key": !session.bypass.bypass && publicKey ? publicKey : "",
    "public-cache-path": !session.bypass.bypass && publicKey ? publicCacheDir : "",
  });
  return planDoc;
}

export function resolvePublic(environment = process.env) {
  const planFile = environment.RECEIPT_PLAN || "";
  if (!planFile || !existsSync(planFile)) return null;
  const planDoc = parseJsonSafe(readFileSync(planFile, "utf8"), null);
  if (!planDoc || planDoc.privateRepo || planDoc.bypassFlag) return planDoc;
  const allowedNamespaces = planDoc.eventName === "pull_request" ? ["trusted", "pr"] : ["trusted"];
  for (const step of planDoc.steps) {
    if (!step.canSkip || !step.inputDigest) continue;
    const file = path.join(planDoc.publicCacheDir, `${step.inputDigest}.json`);
    if (!existsSync(file)) continue;
    const verified = verifyReceiptStatement(parseJsonSafe(readFileSync(file, "utf8"), null), {
      repository: planDoc.repository, repositoryId: planDoc.repositoryId,
      treeSha: planDoc.treeSha, inputDigest: step.inputDigest, workflowSha: planDoc.workflowSha,
      cacheEpoch: planDoc.cacheEpoch, checkId: step.checkId, allowedNamespaces,
    });
    if (verified.valid) {
      step.cachedHit = true;
      step.reusedRunId = String(verified.receipt.run_id ?? "");
      step.reusedRunUrl = String(verified.receipt.run_url ?? "");
      step.reusedEvent = String(verified.receipt.event_name ?? "");
      if (!planDoc.canary) { step.skip = true; step.reused = true; }
    }
  }
  if (planDoc.artifact !== "" && planDoc.steps.length > 0 && planDoc.steps.every((s) => s.skip)) {
    const last = planDoc.steps.at(-1);
    last.skip = false;
    last.reused = false;
  }
  planDoc.all_skipped = planDoc.steps.length > 0 && planDoc.steps.every((s) => s.skip);
  writeFileSync(planFile, JSON.stringify(planDoc, null, 2));
  return planDoc;
}

export async function finish(environment = process.env, deps = {}) {
  const planFile = environment.RECEIPT_PLAN || "";
  const resultsFile = environment.RECEIPT_RESULTS || "";
  const runnerReason = (environment.RUNNER_REASON || "").trim();
  if (!planFile || !existsSync(planFile)) {
    writeActionOutputs(environment.GITHUB_OUTPUT, {
      "receipt-mode": "executed", "reused-run-id": "", "bypass-reason": "",
      "canary-result": "", "save-public-key": "", "save-public-path": "",
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
  let wrotePublic = false;

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
      } else if (!planDoc.privateRepo && planDoc.publicKey && !isReleaseRef(planDoc.ref)) {
        mkdirSync(planDoc.publicCacheDir, { recursive: true });
        writeFileSync(
          path.join(planDoc.publicCacheDir, `${step.inputDigest}.json`),
          JSON.stringify(buildPublicReceiptStatement({ ...planDoc, checkId: step.checkId, argv: step.argv, inputDigest: step.inputDigest })),
        );
        wrotePublic = true;
      }
    }
    summaryEntries.push(makeSummaryEntry(base, { outcome, canaryResult: matched ? "match" : "" }));
  }

  const stats = summarizeReceiptEntries(summaryEntries, { bypassReason: planDoc.bypassReason, canary: planDoc.canary });
  if (environment.GITHUB_STEP_SUMMARY && (summaryEntries.length > 0 || planDoc.bypassReason)) {
    appendFileSync(environment.GITHUB_STEP_SUMMARY, `\n${formatReceiptSummary(summaryEntries, { bypassReason: planDoc.bypassReason, canary: planDoc.canary })}\n`);
  }
  const savePublic = !planDoc.privateRepo && wrotePublic && failed.size === 0 && Boolean(planDoc.publicKey);
  writeReceiptMetadata(environment.RUNNER_TEMP, stats);
  writeActionOutputs(environment.GITHUB_OUTPUT, {
    "receipt-mode": stats.mode, "reused-run-id": stats.reusedRunId,
    "bypass-reason": stats.bypassReason, "canary-result": stats.canaryResult,
    "save-public-key": savePublic ? planDoc.publicKey : "",
    "save-public-path": savePublic ? planDoc.publicCacheDir : "",
  });
  return { stats, summaryEntries, savePublic };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const modes = { prepare, resolve: resolvePublic, finish };
  const fn = modes[process.argv[2] || ""];
  if (!fn) { console.error("::error::receipts mode must be prepare, resolve or finish"); process.exitCode = 1; }
  else Promise.resolve(fn()).catch((error) => { console.error(`::error::${error.message.replace(/[\r\n%]/g, " ")}`); process.exitCode = 1; });
}
