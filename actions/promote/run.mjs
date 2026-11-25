import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { client, qualifyWorkflows, qualificationWorkflows, recheck, transferArtifacts } from "../../lib/qualification.mjs";
import { UnversionedError } from "../../lib/release.mjs";
import { releaseVersion } from "../../lib/release-version.mjs";
import { selectPromotion } from "../../lib/promotion.mjs";

export async function main(environment = process.env) {
  const input = (name) => environment[`INPUT_${name.toUpperCase()}`] || "";
  const token = input("github-token");
  if (!token) throw new Error("A read token is required to choose the commit.");
  const github = client(token, environment.GITHUB_API_URL, {retryReads: true});
  const fallbackActorId = environment.NDDEV_BRANCH_FALLBACK_ACTOR_ID;
  const workflows = qualificationWorkflows(`.github/workflows/${input("check-workflow") || "ci.yml"}`, input("required-workflows"));
  const result = await selectPromotion(github, {
    repository: environment.GITHUB_REPOSITORY,
    workflowPath: `.github/workflows/${input("check-workflow") || "ci.yml"}`,
    requiredWorkflows: input("required-workflows"), fallbackActorId,
    source: input("source-branch") || "dev", target: input("target-branch") || "main",
  });
  const prereleaseFile = input("prerelease-file").trim();
  if (result.state === "ready" && (input("release-metadata") || prereleaseFile || workflows.length > 1)) {
    const qualifications = await qualifyWorkflows(github, {repository: environment.GITHUB_REPOSITORY,
      sha: result.sha, workflowPath: workflows[0], branch: input("source-branch") || "dev"},
    input("required-workflows"), {waitMinutes: 0, fallbackActorId});
    if (input("release-metadata") || prereleaseFile) {
      let files = [];
      let parent;
      try {
        if (input("release-metadata")) {
          const temp = environment.RUNNER_TEMP;
          if (!temp) throw new Error("The runner did not provide RUNNER_TEMP.");
          mkdirSync(temp, {recursive: true});
          parent = mkdtempSync(path.join(temp, "nddev-ci-promotion-"));
          const transferred = await transferArtifacts(github, qualifications[0], input("artifacts"), path.join(parent, "checked"), {
            githubToken: token,
            actor: environment.GITHUB_ACTOR || "x-access-token",
            registryUrl: environment.NDDEV_CI_OCI_REGISTRY_URL || undefined,
            env: environment,
            fallbackActorId,
          });
          files = transferred.files;
        }
        result.version = await releaseVersion(github, {
          repository: environment.GITHUB_REPOSITORY,
          sha: result.sha,
          files,
          metadata: input("release-metadata"),
          prereleaseFile,
        });
      } catch (error) {
        if (!(error instanceof UnversionedError)) throw error;
        Object.assign(result, {state: "unversioned", reason: error.message, sha: null});
      } finally { if (parent) rmSync(parent, {recursive: true, force: true}); }
    }
    if (result.state === "ready") await Promise.all(qualifications.map((qualified, index) =>
      recheck(github, qualified, {fallbackActorId: index === 0 ? fallbackActorId : undefined})));
  }
  for (const {sha, state, reason} of result.skipped ?? []) console.log(`Passed over ${sha}: ${state}. ${reason}`);
  appendFileSync(environment.GITHUB_OUTPUT, `state=${result.state}\nsha=${result.sha ?? ""}\n`);
  console.log(result.state === "ready" ? `Promoting ${result.sha}, checked by run ${result.run_id}.`
    : result.state === "current" ? "Nothing new to promote."
    : result.state === "unversioned" ? `::notice::${result.reason}`
    : "No new commit has a passed check yet.");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => { console.error(`::error::${error.message.replace(/[\r\n%]/g, " ")}`); process.exitCode = 1; });
