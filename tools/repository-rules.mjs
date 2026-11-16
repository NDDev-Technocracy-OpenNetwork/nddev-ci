import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { client } from "../lib/qualification.mjs";

const refuse = (message) => { throw new Error(message); };
const canonical = (value) => Array.isArray(value) ? value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) :
  value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const fields = ["name", "target", "enforcement", "bypass_actors", "conditions", "rules"];
const definition = (value) => Object.fromEntries(fields.map((key) => [key, value?.[key]]));
const equal = (a, b) => JSON.stringify(canonical(definition(a))) === JSON.stringify(canonical(definition(b)));

/** Reconciles one named ruleset, preserving every unrelated rule; lost writes require observed agreement. */
export async function reconcile(github, repository, desired, mode) {
  const checks = desired?.rules?.[0]?.parameters?.required_status_checks;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      repository.split("/").some((part) => [".", ".."].includes(part)) || !["plan", "apply"].includes(mode) ||
      typeof desired?.name !== "string" || !desired.name || desired.target !== "branch" || desired.enforcement !== "active" ||
      !Array.isArray(desired.bypass_actors) || desired.bypass_actors.length || desired.rules?.length !== 1 ||
      desired.rules[0].type !== "required_status_checks" || !Array.isArray(checks) || !checks.length ||
      checks.some((c) => typeof c.context !== "string" || !c.context || /[\x00-\x1f\x7f]/.test(c.context) ||
        !Number.isSafeInteger(c.integration_id) || c.integration_id <= 0) || new Set(checks.map((c) => c.context)).size !== checks.length)
    refuse("An active, bypass-free required-check declaration and exact repository are required.");
  const route = `/repos/${repository}/rulesets`;
  async function observed() {
    const rows = await github.json("GET", `${route}?includes_parents=false&per_page=100`);
    if (!Array.isArray(rows) || rows.length >= 100 || rows.some((r) => !Number.isSafeInteger(r?.id) || r.id <= 0 ||
        r.source_type !== "Repository" || r.source !== repository)) refuse("The repository ruleset inventory is incomplete or foreign.");
    if (new Set(rows.map((r) => r.id)).size !== rows.length) refuse("The ruleset inventory repeats an identity.");
    const matching = rows.filter((r) => r.name === desired.name);
    if (matching.length > 1) refuse("The managed ruleset name is ambiguous.");
    if (!matching.length) return null;
    const value = await github.json("GET", `${route}/${matching[0].id}`);
    if (value?.id !== matching[0].id || value.source_type !== "Repository" || value.source !== repository)
      refuse("The selected ruleset has foreign identity.");
    return value;
  }
  const before = await observed();
  if (before && equal(before, desired)) return {state: "current", id: before.id};
  if (mode === "plan") return {state: before ? "update" : "create", id: before?.id ?? null};
  let writeError;
  try { await github.json(before ? "PUT" : "POST", before ? `${route}/${before.id}` : route, {body: desired}); }
  catch (error) { writeError = error; }
  const after = await observed();
  if (after && equal(after, desired)) return {state: "applied", id: after.id};
  if (writeError) throw writeError;
  refuse("The ruleset did not reach the declared check and bypass policy.");
}

async function main() {
  const [repository, mode = "plan", ...extra] = process.argv.slice(2);
  if (extra.length) refuse("Usage: repository-rules.mjs owner/repository [plan|apply]");
  const desired = JSON.parse(readFileSync(new URL("../.github/rulesets/dev.json", import.meta.url), "utf8"));
  // Administration runs outside ordinary CI. gh supplies its existing authenticated identity.
  const token = process.env.GH_TOKEN || execFileSync("gh", ["auth", "token"], {stdio: ["ignore", "pipe", "pipe"], encoding: "utf8"}).trim();
  if (!token) refuse("An authenticated repository administrator is required.");
  console.log(JSON.stringify(await reconcile(client(token), repository, desired, mode)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => { console.error(error.message.replace(/[\r\n]/g, " ")); process.exitCode = 1; });
