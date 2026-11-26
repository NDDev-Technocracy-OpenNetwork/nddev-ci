import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkedMergeBase } from "../../lib/dependency-source.mjs";
import { checkWorkflowActions, loadRegistrySnapshot } from "../../lib/registry-resolve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const actionsDir = path.resolve(here, "..");

function spawnCapture(command, args, { cwd, env, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      chunks.push(Buffer.from(`${error.message}\n`, "utf8"));
      resolve({ status: 1, output: Buffer.concat(chunks).toString("utf8") });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code ?? (signal ? 128 : 1), output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

async function runNodeAction(scriptRelPath, { cwd, env, extraEnv = {}, summaryFile = "" }) {
  const script = path.join(actionsDir, scriptRelPath);
  const childEnv = { ...env, ...extraEnv };
  if (summaryFile) childEnv.GITHUB_STEP_SUMMARY = summaryFile;
  return spawnCapture(process.execPath, [script], { cwd, env: childEnv });
}

async function runCommitMessages({ cwd, env, base, head, headRef, scratchDir }) {
  const lines = [];
  const customConfig = path.join(cwd, "committed.toml");
  let config = customConfig;
  const hasCustom = existsSync(customConfig);
  if (!hasCustom) {
    config = path.join(scratchDir, "committed.toml");
    writeFileSync(
      config,
      [
        'style = "conventional"',
        'allowed_types = ["feat", "fix", "chore", "docs", "style", "refactor", "perf", "test", "build", "ci", "revert"]',
        "subject_length = 72",
        "line_length = 100",
        "subject_capitalized = false",
        "imperative_subject = true",
        "no_fixup = true",
        "no_wip = true",
        'ignore_author_re = "^dependabot\\\\[bot\\\\] <49699333\\\\+dependabot\\\\[bot\\\\]@users\\\\.noreply\\\\.github\\\\.com>$"',
        "",
      ].join("\n"),
    );
  }
  const revArgs = headRef && !headRef.startsWith("refs/heads/gh-readonly-queue/")
    ? ["rev-list", "--no-merges", head, `^${base}`, "--not", `--exclude=origin/${headRef}`, "--remotes=origin"]
    : ["rev-list", "--no-merges", head, `^${base}`];
  const revList = await spawnCapture("git", revArgs, { cwd, env });
  if (revList.status !== 0) return { status: 0, output: revList.output };
  const commits = revList.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let failed = false;
  for (const commit of commits) {
    const header = spawnSync("git", ["log", "-1", "--format=%h %s", commit], { cwd, env, encoding: "utf8" });
    if (header.stdout) lines.push(header.stdout.trimEnd());
    const checked = await spawnCapture("committed", ["--config", config, `${commit}^..${commit}`], { cwd, env });
    if (checked.output) lines.push(checked.output.trimEnd());
    if (checked.status !== 0) failed = true;
    if (!hasCustom) {
      const author = spawnSync("git", ["log", "-1", "--format=%an <%ae>", commit], { cwd, env, encoding: "utf8" }).stdout.trim();
      if (author !== "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>") {
        const body = spawnSync("git", ["log", "-1", "--format=%B", commit], { cwd, env, encoding: "utf8" }).stdout;
        const bodyLines = body.replace(/\n$/, "").split("\n");
        const short = commit.slice(0, 7);
        bodyLines.forEach((line, idx) => {
          if (idx === 0 && line.length > 72) {
            lines.push(`::warning::${short}: the subject has ${line.length} characters, more than 72`);
            failed = true;
          } else if (idx > 0 && line.length > 100) {
            lines.push(`::warning::${short}: line ${idx + 1} has ${line.length} characters, more than 100`);
            failed = true;
          }
        });
      }
    }
  }
  if (failed) {
    lines.push("::warning::the commit messages above differ from the commit rules; the merge is not stopped");
  }
  return { status: 0, output: lines.join("\n") + (lines.length ? "\n" : "") };
}

async function runClones({ cwd, env, base, head, merge, binDir, scratchDir }) {
  const gitEnv = { ...env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" };
  const mergeGroup = env.GITHUB_EVENT_NAME === "merge_group";
  let mergeBase;
  try {
    mergeBase = checkedMergeBase(cwd, { base, head, merge, mergeGroup });
  } catch (error) {
    return { status: 1, output: `::error::${String(error.message).replace(/[\r\n%]/g, " ")}\n` };
  }
  const cloneOut = mkdtempSync(path.join(scratchDir, "clones-"));
  const worktreeDir = path.join(cloneOut, "head");
  const policyFile = path.join(cloneOut, "policy.json");
  const blob = spawnSync("git", ["cat-file", "blob", `${mergeBase}:.jscpd.json`], { cwd, env: gitEnv, encoding: "utf8" });
  if (blob.status !== 0) {
    return { status: 1, output: "::error::Commit the project's .jscpd.json on the base branch before enabling the clone stop.\n" };
  }
  writeFileSync(policyFile, blob.stdout);
  const added = spawnSync("git", ["worktree", "add", "--detach", "--quiet", worktreeDir, "HEAD"], { cwd, env: gitEnv, encoding: "utf8" });
  if (added.status !== 0) {
    return { status: 1, output: `${added.stderr || ""}::error::Could not prepare a clean worktree for clone detection.\n` };
  }
  const jscpd = path.join(binDir, "jscpd");
  let res;
  try {
    res = await spawnCapture(
      jscpd,
      [".", "--config", policyFile, "--baseline-from-ref", mergeBase, "--no-gitignore", "--fail-on-new-clones=0", "--reporters", "json", "--silent", "--output", cloneOut],
      { cwd: worktreeDir, env: gitEnv },
    );
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktreeDir], { cwd, env: gitEnv, encoding: "utf8" });
  }
  const reportPath = path.join(cloneOut, "jscpd-report.json");
  if (!existsSync(reportPath)) {
    return { status: 1, output: `${res.output}::error::The clone detector produced no report.\n` };
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const dupLines = [];
  for (const d of report.duplicates || []) {
    if (d.isNew) {
      dupLines.push(JSON.stringify({
        first: { name: d.firstFile.name, start: d.firstFile.start, end: d.firstFile.end },
        second: { name: d.secondFile.name, start: d.secondFile.start, end: d.secondFile.end },
      }));
    }
  }
  const outText = [res.output.trimEnd(), ...dupLines].filter(Boolean).join("\n");
  return { status: res.status, output: outText ? `${outText}\n` : "" };
}

async function runWorkflows({ cwd, env, binDir }) {
  if (!existsSync(path.join(cwd, ".github", "workflows"))) {
    return { status: 0, output: "No workflows in this repository.\n" };
  }
  const expectedShellcheck = path.join(binDir, "shellcheck");
  const resolved = spawnSync("bash", ["-c", "command -v shellcheck"], { cwd, env, encoding: "utf8" });
  if (resolved.status !== 0 || resolved.stdout.trim() !== expectedShellcheck) {
    return { status: 1, output: "::error::the pinned ShellCheck is not first on PATH\n" };
  }
  const scVer = spawnSync(expectedShellcheck, ["--version"], { cwd, env, encoding: "utf8" });
  const versionLine = (scVer.stdout || "").split("\n")[1] || "";

  const [actionlintRes, zizmorRes, poutineRes] = await Promise.all([
    spawnCapture(path.join(binDir, "actionlint"), [], { cwd, env }),
    spawnCapture(path.join(binDir, "zizmor"), ["--no-progress", "--min-severity", "high", ".github"], { cwd, env }),
    new Promise((resolve) => {
      const child = spawn(path.join(binDir, "poutine"), ["analyze_local", ".", "--quiet", "--disable-version-check", "--format", "json"], {
        cwd, env, stdio: ["ignore", "pipe", "pipe"],
      });
      const out = [];
      const err = [];
      child.stdout.on("data", (chunk) => out.push(chunk));
      child.stderr.on("data", (chunk) => err.push(chunk));
      child.on("error", (error) => resolve({ status: 1, stdout: "", stderr: `${error.message}\n` }));
      child.on("close", (code, signal) => resolve({
        status: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }));
    }),
  ]);

  const chunks = [];
  if (versionLine) chunks.push(versionLine);
  if (actionlintRes.output.trimEnd()) chunks.push(actionlintRes.output.trimEnd());
  if (zizmorRes.output.trimEnd()) chunks.push(zizmorRes.output.trimEnd());
  if (poutineRes.stderr.trimEnd()) chunks.push(poutineRes.stderr.trimEnd());

  if (actionlintRes.status !== 0 || zizmorRes.status !== 0 || poutineRes.status !== 0) {
    return {
      status: 1,
      reason: zizmorRes.status !== 0 ? "merge-stop-zizmor" : "merge-stop-workflow",
      output: chunks.join("\n") + "\n",
    };
  }

  let report;
  try {
    report = JSON.parse(poutineRes.stdout);
  } catch {
    chunks.push("::error::poutine did not produce valid JSON output.");
    return { status: 1, output: chunks.join("\n") + "\n" };
  }
  const levels = {};
  for (const [name, rule] of Object.entries(report.rules || {})) {
    levels[name] = rule?.level || "";
  }
  let stops = 0;
  for (const finding of report.findings || []) {
    const level = levels[finding.rule_id] || "";
    const meta = finding.meta || {};
    chunks.push(`${level || "note"}: ${finding.rule_id} in ${meta.path}:${meta.line} ${meta.details || ""}`);
    if (level === "warning" || level === "error") stops += 1;
  }

  const snapshot = loadRegistrySnapshot(env);
  if (snapshot) {
    const workflowFiles = [];
    const wfDir = path.join(cwd, ".github", "workflows");
    if (existsSync(wfDir)) {
      for (const name of readdirSync(wfDir).sort()) {
        if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
        workflowFiles.push({
          path: `.github/workflows/${name}`,
          content: readFileSync(path.join(wfDir, name), "utf8"),
        });
      }
    }
    const actionCheck = checkWorkflowActions(snapshot, workflowFiles);
    if (actionCheck.violations.length > 0) {
      const baseRef = env.MERGE_STOPS_BASE || env.INPUT_BASE || "";
      const baseViolations = new Set();
      if (/^[0-9a-f]{40}$/.test(baseRef)) {
        const baseFiles = [];
        for (const wf of workflowFiles) {
          const blob = spawnSync("git", ["cat-file", "blob", `${baseRef}:${wf.path}`], { cwd, env, encoding: "utf8" });
          if (blob.status === 0) baseFiles.push({ path: wf.path, content: blob.stdout });
        }
        for (const item of checkWorkflowActions(snapshot, baseFiles).violations) {
          baseViolations.add(`${item.path}:${item.uses}`);
        }
      }
      for (const violation of actionCheck.violations) {
        const isExisting = baseViolations.has(`${violation.path}:${violation.uses}`);
        const level = isExisting ? "warning" : "error";
        chunks.push(`::${level}::Registry action check (${violation.path}:${violation.line}): ${violation.reason}`);
        if (!isExisting) stops += 1;
      }
    }
  }

  return { status: stops > 0 ? 1 : 0, output: chunks.join("\n") + (chunks.length ? "\n" : "") };
}

function flushResult(name, result, summaryFile, targetSummary) {
  process.stdout.write(`::group::${name}\n`);
  if (result.output) {
    process.stdout.write(result.output);
    if (!result.output.endsWith("\n")) process.stdout.write("\n");
  }
  process.stdout.write("::endgroup::\n");
  if (summaryFile && targetSummary && existsSync(summaryFile)) {
    const extra = readFileSync(summaryFile, "utf8");
    if (extra) appendFileSync(targetSummary, extra);
  }
}

export async function runMergeStops(environment = process.env, { customChecks = null } = {}) {
  const workspace = environment.GITHUB_WORKSPACE || process.cwd();
  const tempRoot = environment.RUNNER_TEMP || tmpdir();
  const binDir = environment.MERGE_STOPS_BIN || path.join(tempRoot, "nddev-ci", "bin");
  const base = environment.MERGE_STOPS_BASE || environment.INPUT_BASE || "";
  const head = environment.MERGE_STOPS_HEAD || environment.INPUT_HEAD || "";
  const merge = environment.MERGE_STOPS_MERGE || environment.INPUT_MERGE || "";
  const headRef = environment.MERGE_STOPS_HEAD_REF || environment["INPUT_HEAD-REF"] || environment.GITHUB_HEAD_REF || "";
  const newClones = (environment.MERGE_STOPS_NEW_CLONES || environment["INPUT_NEW-CLONES"]) === "true";
  const upstreamBranch = environment.MERGE_STOPS_UPSTREAM_BRANCH || environment["INPUT_UPSTREAM-BRANCH"] || "";
  const token = environment.MERGE_STOPS_GITHUB_TOKEN || environment["INPUT_GITHUB-TOKEN"] || environment.GH_TOKEN || "";
  const targetSummary = environment.GITHUB_STEP_SUMMARY || "";
  const outputFile = environment.GITHUB_OUTPUT || "";

  const scratchDir = mkdtempSync(path.join(tempRoot, "nddev-merge-stops-"));
  const isolate = environment.MERGE_STOPS_ISOLATED_WORKTREE === "true";
  const cwd = isolate ? path.join(scratchDir, "source") : workspace;
  let added = false;

  try {
    if (isolate) {
      if (!/^[a-f0-9]{40}$/.test(merge)) throw new Error("An exact merge commit is required for inline merge stops.");
      const checkout = await spawnCapture("git", ["worktree", "add", "--detach", "--quiet", cwd, merge], { cwd: workspace, env: environment });
      if (checkout.status !== 0) throw new Error(`Could not prepare the inline merge stops worktree. ${checkout.output.trim()}`);
      added = true;
    }
    const envWithBin = {
      ...environment,
      GITHUB_WORKSPACE: cwd,
      PATH: `${binDir}${path.delimiter}${environment.PATH || ""}`,
    };
    const depSummary = path.join(scratchDir, "dep-summary.md");
    const checks = customChecks ?? [
      {
        name: "Change authorship",
        reason: "merge-stop-authorship",
        projectStop: true,
        run: () => runNodeAction("authorship/run.mjs", {
          cwd, env: envWithBin,
          extraEnv: { INPUT_BASE: base, INPUT_HEAD: head, "INPUT_UPSTREAM-BRANCH": upstreamBranch },
        }),
      },
      {
        name: "Build conventions",
        projectStop: false,
        run: () => runNodeAction("build-conventions/run.mjs", { cwd, env: envWithBin }),
      },
      {
        name: "Commit messages",
        projectStop: false,
        run: () => runCommitMessages({ cwd, env: envWithBin, base, head, headRef, scratchDir }),
      },
      ...(environment.GITHUB_EVENT_NAME !== "merge_group" ? [{
        name: "Pull request text",
        projectStop: false,
        run: () => spawnCapture("python3", ["-I", path.join(here, "pr-text.py")], { cwd, env: envWithBin }),
      }] : []),
      {
        name: "No secret in the change",
        reason: "merge-stop-secret",
        projectStop: true,
        run: () => runNodeAction("secret-scan/run.mjs", {
          cwd, env: envWithBin, extraEnv: { INPUT_BASE: base, INPUT_HEAD: head },
        }),
      },
      {
        name: "No new fixed critical dependency",
        reason: "merge-stop-dependencies",
        projectStop: true,
        summaryFile: depSummary,
        run: () => runNodeAction("dependency-guard/run.mjs", {
          cwd, env: envWithBin, summaryFile: depSummary,
          extraEnv: { INPUT_BASE: base, INPUT_HEAD: head, INPUT_MERGE: merge, "INPUT_GITHUB-TOKEN": token },
        }),
      },
      ...(newClones ? [{
        name: "No new code clones",
        reason: "merge-stop-clones",
        projectStop: true,
        run: () => runClones({ cwd, env: envWithBin, base, head, merge, binDir, scratchDir }),
      }] : []),
      {
        name: "No dangerous workflow",
        reason: "merge-stop-workflow",
        projectStop: true,
        run: () => runWorkflows({ cwd, env: envWithBin, binDir }),
      },
    ];

    const settled = await Promise.allSettled(
      checks.map(async (check) => {
        const result = await check.run({ cwd, env: envWithBin });
        flushResult(check.name, result, check.summaryFile, targetSummary);
        return { ...check, result };
      }),
    );
    const results = settled.map((entry) => {
      if (entry.status === "rejected") throw entry.reason;
      return entry.value;
    });

    // Run planner-speed uncontended after parallel checks settle so CPU timings stay clean.
    const plannerCheck = customChecks ? null : await runNodeAction("planner-speed/run.mjs", {
      cwd, env: envWithBin, extraEnv: { INPUT_BASE: base, INPUT_MERGE: merge },
    });
    if (plannerCheck) {
      flushResult("Planner speed", plannerCheck, "", targetSummary);
      results.push({ name: "Planner speed", reason: "merge-stop-planner-speed", projectStop: true, result: plannerCheck });
    }

    const failedProjectStops = results.filter((entry) => entry.projectStop && entry.result.status !== 0);
    if (failedProjectStops.length > 0) {
      const first = failedProjectStops[0];
      const staleMergeBase = first.result.output?.includes(
        "Dependency merge base is neither the PR base nor a later commit of it.",
      );
      const failureReason = staleMergeBase
        ? "stale-pr-merge-base"
        : (first.result.reason || first.reason || "merge-stops-failed");
      if (outputFile) appendFileSync(outputFile, `failure-layer=project\nfailure-reason=${failureReason}\n`);
      for (const entry of failedProjectStops) {
        process.stderr.write(`::error::Merge stop failed: ${entry.name}\n`);
      }
      return 1;
    }
    return 0;
  } finally {
    try {
      if (added) {
        const removed = await spawnCapture("git", ["worktree", "remove", "--force", cwd], { cwd: workspace, env: environment });
        if (removed.status !== 0) throw new Error(`Could not remove the inline merge stops worktree. ${removed.output.trim()}`);
      }
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMergeStops().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`::error::${String(error.message).replace(/[\r\n%]/g, " ")}`);
    process.exitCode = 1;
  });
}
