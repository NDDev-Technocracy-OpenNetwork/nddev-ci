import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ActionError, downloadAsset } from "../../lib/release-asset.mjs";
import { extract } from "../../lib/native-member.mjs";
import { hostedJustPin } from "../../lib/hosted-compat-pins.mjs";
import { runProjectCommand } from "../../lib/project-command.mjs";
import {
  findManagedTool,
  loadRegistrySnapshot,
  measureToolVersion,
  resolveToolchain,
  resolveToolDigest,
} from "../../lib/registry-resolve.mjs";
import { managedRunner } from "../../lib/runner-profile.mjs";
import {
  buildReceiptSession,
  checkIdForArgv,
  computeInputDigest,
  fetchOidcToken,
  formatReceiptSummary,
  issueStepInSession,
  lookupStepInSession,
  makeSummaryEntry,
  parseJsonSafe,
  readJustDump,
  recipeClosureDigest,
  sanitizeProjectEnv,
  writeActionOutputs,
  writeReceiptMetadata,
} from "../../lib/step-receipts.mjs";
const digest = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

export function parseArguments(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 65536)
    throw new ActionError(
      "Recipe arguments must be a bounded JSON array of strings.",
    );
  let args;
  try {
    args = JSON.parse(value);
  } catch {
    throw new ActionError("Recipe arguments are invalid JSON.");
  }
  if (
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )
    throw new ActionError(
      "Recipe arguments must be a JSON array of strings without NUL bytes.",
    );
  return args;
}

export function invocation({
  workspace,
  directory = ".",
  justfile = "justfile",
  recipe,
  arguments: raw = "[]",
}) {
  if (typeof recipe !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(recipe))
    throw new ActionError("A declared recipe name is required.");
  const root = realpathSync(workspace);
  const cwd = realpathSync(path.resolve(root, directory));
  const file = realpathSync(path.resolve(cwd, justfile));
  for (const candidate of [cwd, file]) {
    const relative = path.relative(root, candidate);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new ActionError(
        "Recipe paths must remain inside the checked-out workspace.",
      );
  }
  return {
    cwd,
    argv: [
      "--working-directory",
      cwd,
      "--justfile",
      file,
      "--",
      recipe,
      ...parseArguments(raw),
    ],
  };
}

async function executable(environment) {
  const snapshot = loadRegistrySnapshot(environment);
  const requested = (
    environment["INPUT_JUST-VERSION"] ??
    environment.NDDEV_CI_JUST_VERSION ??
    ""
  ).trim();
  if (managedRunner(environment.RUNNER_ENVIRONMENT, environment.INPUT_MANAGED)) {
    const found = findManagedTool("just", {
      environment: commandEnvironment(environment),
      snapshot,
      requestedVersion: requested,
      allowPathOutsideCache: true,
    });
    if (found.source === "tool-cache" && environment.GITHUB_PATH) {
      appendFileSync(environment.GITHUB_PATH, `${path.dirname(found.binary)}\n`);
    }
    return { binary: found.binary, expectedVersion: found.version };
  }
  const target = `${process.platform}-${process.arch}`;
  if (!environment.RUNNER_TEMP)
    throw new ActionError("A runner-owned temporary directory is required.");

  const regDigest = snapshot
    ? resolveToolDigest(snapshot, "just", { version: requested, target, optional: true })
    : null;

  let expectedVersion, directory, downloadSpec, memberSpec, cachedValid, onExtracted;
  if (regDigest) {
    expectedVersion = regDigest.version;
    directory = path.join(
      environment.RUNNER_TEMP,
      "nddev-ci",
      "just",
      `${regDigest.version}-${regDigest.sha256.slice(0, 16)}`,
      target,
    );
    const receipt = path.join(directory, ".binary-sha256");
    downloadSpec = {
      repository: regDigest.repository || "casey/just",
      tag: regDigest.version,
      name: regDigest.asset,
      sha256: regDigest.sha256,
      maxBytes: 64 * 1024 * 1024,
    };
    memberSpec = (name) => ({ path: name, maxBytes: 64 * 1024 * 1024 });
    cachedValid = (binary) => {
      const cachedSha = existsSync(receipt) ? readFileSync(receipt, "utf8").trim() : "";
      return existsSync(binary) && /^[0-9a-f]{64}$/.test(cachedSha) && digest(binary) === cachedSha;
    };
    onExtracted = (extracted) => writeFileSync(receipt, `${extracted.sha256}\n`, { mode: 0o600 });
  } else {
    const configuration = hostedJustPin(environment);
    const targetVersion = requested || (snapshot ? resolveToolchain(snapshot, "just").version : configuration.version);
    if (snapshot) resolveToolchain(snapshot, "just", targetVersion);
    if (targetVersion !== configuration.version) {
      throw new ActionError(
        `Hosted just ${targetVersion} has no verified asset digest in this release; supply tool-assets or use a managed runner.`,
      );
    }
    const asset = configuration.targets[target];
    if (!asset)
      throw new ActionError("This runner architecture has no admitted task runner asset.");
    expectedVersion = targetVersion;
    directory = path.join(environment.RUNNER_TEMP, "nddev-ci", "just", targetVersion, target);
    downloadSpec = { ...asset, repository: configuration.repository, tag: targetVersion };
    memberSpec = (name) => ({ path: name, size: asset.binary_size, sha256: asset.binary_sha256 });
    cachedValid = (binary) => existsSync(binary) && digest(binary) === asset.binary_sha256;
    onExtracted = () => {};
  }

  const binary = path.join(directory, process.platform === "win32" ? "just.exe" : "just");
  if (!cachedValid(binary)) {
    mkdirSync(directory, { recursive: true });
    const temporary = mkdtempSync(path.join(directory, "download-"));
    try {
      const archive = path.join(temporary, downloadSpec.name);
      await downloadAsset(
        downloadSpec,
        archive,
        environment["INPUT_GITHUB-TOKEN"],
        environment.NDDEV_CI_ARTIFACT_REGISTRY,
      );
      const source = path.join(temporary, path.basename(binary));
      const extracted = await extract(
        archive,
        memberSpec(path.basename(binary)),
        source,
        commandEnvironment(environment),
      );
      chmodSync(source, 0o755);
      if (existsSync(binary)) rmSync(binary);
      renameSync(source, binary);
      onExtracted(extracted);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  if (environment.GITHUB_PATH)
    appendFileSync(environment.GITHUB_PATH, `${directory}\n`);
  return { binary, expectedVersion };
}

function commandEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => name.toUpperCase() !== "INPUT_GITHUB-TOKEN",
    ),
  );
}

export async function prepareFrontend(environment = process.env) {
  const { binary: just, expectedVersion } = await executable(environment);
  const measured = measureToolVersion(just, "just", commandEnvironment(environment));
  if (!measured || measured !== expectedVersion)
    throw new ActionError("Task runner version differs from its resolved version.");
  if (environment.GITHUB_OUTPUT)
    appendFileSync(
      environment.GITHUB_OUTPUT,
      `just-version=${measured}\n`,
    );
  return just;
}

export async function main(environment = process.env, deps = {}) {
  const input = (name) => (environment[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const workingDirectory = input("working-directory") || ".";
  const justfile = input("justfile") || "justfile";
  const request = invocation({
    workspace: environment.GITHUB_WORKSPACE,
    directory: workingDirectory,
    justfile,
    recipe: input("recipe"),
    arguments: input("arguments") || "[]",
  });
  const just = await prepareFrontend(environment);
  const childEnvironment = sanitizeProjectEnv(commandEnvironment(environment));
  if (path.isAbsolute(just)) {
    const originalPath = environment.PATH ?? environment.Path ?? "";
    for (const name of Object.keys(childEnvironment))
      if (name.toLowerCase() === "path") delete childEnvironment[name];
    childEnvironment.PATH = `${path.dirname(just)}${path.delimiter}${originalPath}`;
  }

  const receiptRaw = input("receipt-inputs");
  const workflowInputs = receiptRaw ? parseJsonSafe(receiptRaw, null) : null;
  let ctx = null;

  if (workflowInputs && environment.RUNNER_ENVIRONMENT === "self-hosted" && environment.NDDEV_CI_RECEIPT_GATEWAY) {
    const session = await buildReceiptSession(environment, workflowInputs, { wholeJobArtifact: true, deps });
    const argv = [input("recipe"), ...parseArguments(input("arguments") || "[]")];
    const checkId = checkIdForArgv(argv, { kind: "recipe", workingDirectory, justfile });
    const dump = (deps.readJustDump ?? readJustDump)(request.cwd, path.resolve(request.cwd, justfile));
    const inputDigest = session.workflowSha && session.treeSha
      ? computeInputDigest({
        cacheEpoch: session.cacheEpoch, workflowSha: session.workflowSha, checkId,
        treeSha: session.treeSha, lockfilesDigest: session.lockfilesDigest,
        recipeDigest: recipeClosureDigest(dump, argv, { workingDirectory, justfile }),
        toolchainDigest: session.toolchainDigest, runnerDigest: session.runnerDigest,
      })
      : "";
    ctx = { session, label: `just ${argv.join(" ")}`, argv, checkId, inputDigest, cachedHit: false, reusedRunId: "", reusedRunUrl: "", reusedEvent: "" };
    const lookup = await lookupStepInSession(session, { checkId, inputDigest }, deps);
    if (lookup.hit) {
      ctx.cachedHit = true;
      ctx.reusedRunId = String(lookup.receipt.run_id ?? "");
      ctx.reusedRunUrl = String(lookup.receipt.run_url ?? "");
      ctx.reusedEvent = String(lookup.receipt.event_name ?? "");
      if (!session.canary) {
        console.log(`Reused step receipt for \`${ctx.label}\` from run #${ctx.reusedRunId} (${ctx.reusedRunUrl})`);
        if (environment.GITHUB_STEP_SUMMARY) {
          appendFileSync(environment.GITHUB_STEP_SUMMARY, `
${formatReceiptSummary([makeSummaryEntry({ ...ctx, treeSha: session.treeSha }, { outcome: "reused (pass)", reused: true })])}
`);
        }
        writeReceiptMetadata(environment.RUNNER_TEMP, { mode: "reused", reusedRunId: ctx.reusedRunId });
        writeActionOutputs(environment.GITHUB_OUTPUT, { "receipt-mode": "reused", "reused-run-id": ctx.reusedRunId, "bypass-reason": "", "canary-result": "" });
        return;
      }
    }
  }

  const status = await runProjectCommand(just, request.argv, {
    cwd: request.cwd,
    environment: childEnvironment,
  }).catch(() => { throw new ActionError("Recipe process did not complete."); });

  if (ctx) {
    const { session } = ctx;
    if (status !== 0) {
      const mismatch = session.canary && ctx.cachedHit;
      if (mismatch) {
        console.error(`::error::Canary re-execution failed for "${ctx.label}" despite cached green receipt from run #${ctx.reusedRunId}; inspect receipt inputs or bump CACHE_EPOCH.`);
      }
      const failMode = session.bypass.bypass ? "bypassed" : (mismatch ? "canary" : "executed");
      writeReceiptMetadata(environment.RUNNER_TEMP, { mode: failMode, reusedRunId: ctx.reusedRunId, bypassReason: session.bypass.reason, canaryResult: mismatch ? "mismatch" : "" });
      writeActionOutputs(environment.GITHUB_OUTPUT, {
        "receipt-mode": failMode,
        "reused-run-id": ctx.reusedRunId, "bypass-reason": session.bypass.reason, "canary-result": mismatch ? "mismatch" : "",
      });
      throw new ActionError(`Recipe failed with exit code ${status}.`);
    }
    if (session.eventName === "pull_request" && !session.bypass.bypass && ctx.inputDigest) {
      const oidc = await (deps.fetchOidcToken ?? fetchOidcToken)(environment, environment.NDDEV_CI_RECEIPT_AUDIENCE || undefined, deps.fetchImpl);
      if (oidc?.token) await issueStepInSession(session, ctx, oidc.token, deps);
    }
    const matched = session.canary && ctx.cachedHit;
    const mode = session.bypass.bypass ? "bypassed" : (matched ? "canary" : "executed");
    if (environment.GITHUB_STEP_SUMMARY && (session.bypass.bypass || matched)) {
      const entry = makeSummaryEntry({ ...ctx, treeSha: session.treeSha }, {
        outcome: matched ? "canary match (pass)" : `bypassed (${session.bypass.reason})`,
        canaryResult: matched ? "match" : "",
      });
      appendFileSync(environment.GITHUB_STEP_SUMMARY, `
${formatReceiptSummary([entry], { bypassReason: session.bypass.reason, canary: session.canary })}
`);
    }
    writeReceiptMetadata(environment.RUNNER_TEMP, { mode, reusedRunId: ctx.reusedRunId, bypassReason: session.bypass.reason, canaryResult: matched ? "match" : "" });
    writeActionOutputs(environment.GITHUB_OUTPUT, {
      "receipt-mode": mode, "reused-run-id": ctx.reusedRunId, "bypass-reason": session.bypass.reason, "canary-result": matched ? "match" : "",
    });
    return;
  }

  if (status !== 0)
    throw new ActionError(`Recipe failed with exit code ${status}.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `::error::${error instanceof ActionError ? error.message : "Recipe action failed before completion."}`,
    );
    process.exitCode = 1;
  });
}
