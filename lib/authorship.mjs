import { spawnSync } from "node:child_process";

// Match a signature, not discussion of a tool or a legitimate human collaborator.
const assistant = String.raw`(?:Claude(?: Code| (?:Opus|Sonnet|Haiku)[\w .-]*)?|Codex|ChatGPT|OpenAI(?: Codex)?|GitHub Copilot|Copilot|Cursor(?: Agent)?|Gemini(?: CLI)?|Aider|Windsurf)`;
const generated = new RegExp(String.raw`^(?:generated|written|authored|implemented)\s+(?:with|by|using)\s+(?:\*\*|__)?\[?${assistant}(?:\b|$)`, "i");
const coauthor = new RegExp(String.raw`^(?:co-authored-by|signed-off-by):\s*${assistant}\s*<(?:(?:noreply|no-reply|codex|cursoragent|copilot)[^<>@\s]*|[0-9]+\+(?:copilot|claude|codex)(?:\[bot\])?)@(?:anthropic\.com|openai\.com|cursor\.com|github\.com|users\.noreply\.github\.com|google\.com)>\s*$`, "i");

export function attribution(text) {
  const found = [];
  let fence;
  for (const [index, raw] of (text ?? "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    const marker = line.match(/^([`~])\1{2,}/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1] === fence) fence = undefined;
      continue;
    }
    if (fence || line.startsWith(">") || /^(?: {4}|\t)/.test(raw)) continue;
    const signature = line.replace(/^(?:🤖|✍️)\s*/, "").replace(/^(?:\*\*|__)/, "");
    if (generated.test(signature) || coauthor.test(signature)) found.push(index + 1);
  }
  return found;
}

const commitId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function git(workspace, args, refusal) {
  const result = spawnSync("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: workspace, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error || result.status !== 0) throw new Error(refusal);
  return result.stdout;
}

function resolveUpstream(workspace, branch, request) {
  if (branch === undefined || branch === null || branch === "") return undefined;
  if (typeof branch !== "string" || /[\0-\x20\x7f~^:?*[\\]/.test(branch) ||
      branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") ||
      branch.startsWith("refs/") || branch.includes("..") || branch.includes("@{"))
    throw new Error("The declared upstream branch name is invalid.");
  git(workspace, ["check-ref-format", "refs/heads/" + branch],
    "The declared upstream branch name is invalid.");
  const headRepo = request?.head?.repo?.full_name;
  const baseRepo = request?.base?.repo?.full_name;
  const sameRepo = !headRepo || !baseRepo || headRepo === baseRepo;
  if (branch === request?.base?.ref || (sameRepo && branch === request?.head?.ref))
    throw new Error("The declared upstream branch must differ from the pull request branches.");
  const commit = git(workspace, ["rev-parse", "--verify", "--end-of-options",
    "refs/remotes/origin/" + branch + "^{commit}"],
    "The declared upstream branch is unavailable.").trim();
  if (!commitId.test(commit)) throw new Error("The declared upstream branch is unavailable.");
  return commit;
}

export function inspect(workspace, { base, head, request, upstreamBranch = "" }) {
  for (const commit of [base, head]) {
    if (typeof commit !== "string" || !commitId.test(commit))
      throw new Error("Authorship inspection requires exact base and head commits.");
  }
  const upstream = resolveUpstream(workspace, upstreamBranch, request);
  // Merge commits are included. The other stops' checkout already holds the full history.
  const range = [head, "^" + base, ...(upstream ? ["^" + upstream] : []), "--"];
  const output = git(workspace, ["log", "--no-show-signature", "--format=%H%x00%B%x00", ...range],
    "The change's commit messages are unavailable.");
  const found = [];
  for (const [where, text] of [["title", request.title], ["description", request.body]]) {
    for (const line of attribution(text)) found.push({ where, line });
  }
  const fields = output.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const commit = fields[index].trim();
    if (!commitId.test(commit))
      throw new Error("Git returned an invalid commit identity.");
    for (const line of attribution(fields[index + 1])) found.push({ where: "commit " + commit, line });
  }
  return found;
}
