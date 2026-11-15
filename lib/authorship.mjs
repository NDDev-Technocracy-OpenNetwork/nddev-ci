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

export function inspect(workspace, { base, head, request }) {
  for (const commit of [base, head]) {
    if (typeof commit !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit))
      throw new Error("Authorship inspection requires exact base and head commits.");
  }
  // Merge commits are included. The other stops' checkout already holds the full history.
  const result = spawnSync("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null",
    "log", "--no-show-signature", "--format=%H%x00%B%x00", base + ".." + head], {
    cwd: workspace, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error || result.status !== 0) throw new Error("The change's commit messages are unavailable.");
  const found = [];
  for (const [where, text] of [["title", request.title], ["description", request.body]]) {
    for (const line of attribution(text)) found.push({ where, line });
  }
  const fields = result.stdout.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const commit = fields[index].trim();
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit))
      throw new Error("Git returned an invalid commit identity.");
    for (const line of attribution(fields[index + 1])) found.push({ where: "commit " + commit, line });
  }
  return found;
}
