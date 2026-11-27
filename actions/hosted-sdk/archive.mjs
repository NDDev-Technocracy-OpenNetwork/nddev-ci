import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { ActionError } from "../../lib/release-asset.mjs";

export async function downloadArchive(url, destination, expected, sdk, { algorithm = "sha256", size = null } = {}) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(1800000) });
  if (!response.ok || !response.body)
    throw new ActionError(`The ${sdk} archive download failed: HTTP ${response.status}.`);
  const hash = createHash(algorithm);
  let totalBytes = 0;
  const output = openSync(destination, "wx", 0o600);
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      totalBytes += chunk.length;
      if (size !== null && totalBytes > size)
        throw new ActionError(`The ${sdk} archive exceeds its published size.`);
      let written = 0;
      while (written < chunk.length) written += writeSync(output, chunk, written, chunk.length - written);
    }
  } finally {
    closeSync(output);
  }
  if (size !== null && totalBytes !== size)
    throw new ActionError(`The ${sdk} archive differs from its published size.`);
  if (hash.digest("hex") !== expected)
    throw new ActionError(`The ${sdk} archive differs from its published digest.`);
}
