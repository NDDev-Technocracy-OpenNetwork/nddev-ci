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

function buildSteps(dump, eventName, partRaw, artifact) {
  if (eventName === "pull_request") {
    const steps = [{ label: "check", argv: ["check"], canSkip: true, canIssue: true }];
    if (dump && ((dump.recipes && Object.hasOwn(dump.recipes, "test")) || (dump.aliases && Object.hasOwn(dump.aliases, "test")))) {
      steps.push({ label: "test", argv: ["test"], canSkip: true, canIssue: true });
    }
    return steps;
  }
  const part = parseJsonSafe(partRaw, []);
  if (Array.isArray(part) && part.length > 0 && !(part.length === 1 && part[0] === "verify")) {
    return [{ label: part.join(" "), argv: part.map(String), canSkip: !(artifact && isArtifactProducingPart({ argv: part, group: part[0] })), canIssue: true }];
  }
  const decomposed = inspectVerifyDecomposition(dump);
  if (decomposed.canDecompose && decomposed.priors.length > 0) {
    const steps = decomposed.priors.map((prior) => ({
      label: prior.argv.join(" "), argv: prior.argv, needs: prior.needs,
      canSkip: !(artifact && isArtifactProducingPart({ argv: prior.argv, group: prior.key })), canIssue: true,
    }));
    if (decomposed.hasBody) steps.push({ label: "verify (body)", argv: ["--no-deps", "verify"], canSkip: false, canIssue: false });
    return steps;
  }
  return [{ label: "verify", argv: ["verify"], canSkip: !artifact, canIssue: true }];
}

export async function prepare(environment = process.env, deps = {}) {
  const cwd = environment.GITHUB_WORKSPACE || process.cwd();
  const tempDir = environment.RUNNER_TEMP || cwd;
  const workflowInputs = parseJsonSafe(environment.RECEIPT_INPUTS, {});
  const setup = environment.SETUP === "true" || workflowInputs.setup === true || workflowInputs.setup === "true";
  const dump = (deps.readJustDump ?? readJustDump)(cwd);
  if (!dump) {
    writeActionOutputs(environment.GITHUB_OUTPUT, { "plan-file": "", "results-file": "" });
    return null;
  }

  const eventName = environment.EVENT || environment.GITHUB_EVENT_NAME || "";
  const artifact = String(workflowInputs.artifact ?? "").trim();
  const steps = buildSteps(dump, eventName, environment.PART || "", artifact);
  const session = await buildReceiptSession(environment, { ...workflowInputs, setup }, {
    wholeJobArtifact: steps.length === 1 && artifact !== "",
    deps,
  });

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
    const entry = {
      label: step.label, argv: step.argv, checkId, canSkip: step.canSkip,
      canIssue: step.canIssue && session.eventName === "pull_request" && !session.bypass.bypass && Boolean(inputDigest),
      inputDigest, skip: false, reused: false, cachedHit: false, reusedRunId: "", reusedRunUrl: "", reusedEvent: "",
    };
    if (step.canSkip) {
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
      summaryEntries.push(makeSummaryEntry(base, { outcome: "reused (pass)", reused: true }));
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
