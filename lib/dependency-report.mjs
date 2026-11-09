import path from "node:path";

export class DependencyError extends Error {}
const refuse = (message) => { throw new DependencyError(message); };
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse(`Invalid ${label}.`);
  return value;
}
function array(value, label) {
  if (!Array.isArray(value)) refuse(`Missing or invalid ${label}.`);
  return value;
}
function text(value, label, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) refuse(`Invalid ${label}.`);
  return value;
}
function strings(value, label) { return array(value, label).map((entry) => text(entry, label)); }

// Consume the scanner's computed CVSS score. This policy neither calculates severity nor
// infers a fix from a version comparison; fixed events come from the matched OSV advisory.
export function findings(report, root, files) {
  object(report, "scanner report");
  const accepted = new Set(files);
  const result = [];
  let packageCount = 0;
  for (const source of array(report.results, "scanner results")) {
    object(source.source, "scanner source");
    if (source.source.type !== "lockfile") refuse("Scanner returned a source outside the declared lockfile scope.");
    const location = text(source.source.path, "scanner source path");
    if (!path.isAbsolute(location)) refuse("Scanner source path is not absolute.");
    const relative = path.relative(root, location).split(path.sep).join("/");
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !accepted.has(relative)) refuse("Scanner source differs from its exact Git inputs.");
    for (const entry of array(source.packages, "scanner packages")) {
      object(entry, "scanner package");
      const pkg = object(entry.package, "package identity");
      const name = text(pkg.name, "package name");
      const ecosystem = text(pkg.ecosystem, "package ecosystem");
      const version = text(pkg.version, "package version");
      packageCount++;
      const vulnerabilities = entry.vulnerabilities === undefined ? [] : array(entry.vulnerabilities, "vulnerabilities");
      const groups = entry.groups === undefined ? [] : array(entry.groups, "vulnerability groups");
      const indexed = new Map();
      for (const value of vulnerabilities) {
        object(value, "OSV vulnerability");
        const id = text(value.id, "OSV identity");
        if (indexed.has(id)) refuse("Scanner repeated an OSV identity.");
        indexed.set(id, value);
      }
      const used = new Set();
      for (const group of groups) {
        object(group, "vulnerability group");
        const ids = strings(group.ids, "group identities");
        if (!ids.length) refuse("Scanner returned an empty vulnerability group.");
        const aliases = new Set([...ids, ...strings(group.aliases, "group aliases")]);
        const score = text(group.max_severity, "scanner severity", true);
        if (score !== "" && (!/^(?:10(?:\.0)?|[0-9](?:\.[0-9]+)?)$/.test(score) || Number(score) > 10)) refuse("Scanner returned an invalid computed severity.");
        const fixes = new Set();
        for (const id of ids) {
          const advisory = indexed.get(id);
          if (!advisory || used.has(id)) refuse("Scanner vulnerability grouping is inconsistent.");
          used.add(id);
          for (const alias of strings(advisory.aliases ?? [], "OSV aliases")) aliases.add(alias);
          for (const affected of array(advisory.affected, "affected packages")) {
            object(affected, "affected package");
            const identity = object(affected.package, "affected package identity");
            if (identity.name !== name || identity.ecosystem !== ecosystem) continue;
            for (const range of array(affected.ranges ?? [], "affected ranges")) {
              for (const event of array(range.events, "affected range events")) {
                object(event, "affected range event");
                if (event.fixed !== undefined && event.fixed !== "") fixes.add(text(event.fixed, "fixed version"));
              }
            }
          }
        }
        result.push({ source: relative, name, ecosystem, version, ids: [...new Set(ids)].sort(), aliases: [...aliases].sort(), severity: score === "" ? null : Number(score), fixed: [...fixes].sort() });
      }
      if (used.size !== indexed.size) refuse("Scanner omitted vulnerability group metadata.");
    }
  }
  return { packages: packageCount, findings: result };
}

export function compareReports(base, head, renames = new Map()) {
  const previous = new Map();
  const key = (finding, source) => JSON.stringify([source, finding.ecosystem, finding.name]);
  for (const finding of base.findings) {
    const scope = key(finding, renames.get(finding.source) ?? finding.source);
    const aliases = previous.get(scope) ?? new Set();
    for (const id of finding.aliases) aliases.add(id);
    previous.set(scope, aliases);
  }
  const introduced = [];
  const diagnostics = { preexisting: 0, criticalWithoutFix: 0, noncritical: 0, unknownSeverity: 0 };
  for (const finding of head.findings) {
    const known = previous.get(key(finding, finding.source));
    const preexisting = finding.aliases.some((id) => known?.has(id));
    if (preexisting) diagnostics.preexisting++;
    if (finding.severity === null) diagnostics.unknownSeverity++;
    else if (finding.severity < 9) diagnostics.noncritical++;
    else if (!finding.fixed.length) diagnostics.criticalWithoutFix++;
    else if (!preexisting) introduced.push(finding);
  }
  return { introduced, diagnostics, basePackages: base.packages, headPackages: head.packages };
}
