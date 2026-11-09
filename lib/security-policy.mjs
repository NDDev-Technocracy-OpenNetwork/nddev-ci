// Policy is private job data, outside every directory being scanned. Its empty contents select
// the scanner defaults rather than a checkout's exclusions; the workflow supplies our flags.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export function scannerPolicy(environment, name) {
  if (!environment.RUNNER_TEMP || !path.isAbsolute(environment.RUNNER_TEMP))
    throw new Error(
      "Daily scans require the job's private temporary directory.",
    );
  const temporary = realpathSync(environment.RUNNER_TEMP);
  const relative = path.relative(
    realpathSync(environment.GITHUB_WORKSPACE),
    temporary,
  );
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    throw new Error(
      "Daily scanner policy must stay outside the scanned checkout.",
    );
  const directory = mkdtempSync(path.join(temporary, "nddev-security-policy-"));
  const config = path.join(directory, name);
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    writeFileSync(config, "", { flag: "wx", mode: 0o400 });
  } catch (error) {
    cleanup();
    throw error;
  }
  return { config, cleanup };
}
