import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { ActionError } from "../../lib/release-asset.mjs";

export async function downloadArchive(url, destination, expected, sdk) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(1800000) });
  if (!response.ok || !response.body)
    throw new ActionError(`The ${sdk} archive download failed: HTTP ${response.status}.`);
  const hash = createHash("sha256");
  const output = openSync(destination, "wx", 0o600);
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) written += writeSync(output, chunk, written, chunk.length - written);
    }
  } finally {
    closeSync(output);
  }
  if (hash.digest("hex") !== expected)
    throw new ActionError(`The ${sdk} archive differs from its published digest.`);
}
