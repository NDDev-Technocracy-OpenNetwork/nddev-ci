import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { openSync, writeSync, closeSync } from "node:fs";

export class ActionError extends Error {}
export function validateAsset(asset) {
  if (
    !asset ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(
      asset.repository,
    ) ||
    !Number.isSafeInteger(asset.asset) ||
    asset.asset < 1 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1 ||
    !/^[0-9a-f]{64}$/.test(asset.sha256)
  )
    throw new ActionError(
      "Release asset source, size and digest must be explicit pins.",
    );
}

export async function downloadAsset(asset, destination, token, registry = "") {
  validateAsset(asset);
  let url = `https://api.github.com/repos/${asset.repository}/releases/assets/${asset.asset}`;
  if (registry) {
    let base;
    try { base = new URL(registry); } catch { throw new ActionError("Invalid declared artifact registry."); }
    if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash ||
        !/^[A-Za-z0-9._-]+$/.test(asset.tag ?? "") || !/^[A-Za-z0-9._+-]+$/.test(asset.name ?? ""))
      throw new ActionError("The declared artifact registry requires a safe base URL, release tag and asset name.");
    url = `${base.href.replace(/\/$/, "")}/github-releases/sha256/${asset.sha256}/${asset.repository}/releases/download/${asset.tag}/${asset.name}`;
  }
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const signal = AbortSignal.timeout(30000);
      response = await fetch(url, {
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "nddev-ci",
          ...(!registry && token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: "manual",
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (registry) throw new ActionError("The declared artifact registry redirected its download.");
        const location = new URL(response.headers.get("location") ?? "", url);
        if (
          location.protocol !== "https:" ||
          !location.hostname.endsWith(".githubusercontent.com")
        )
          throw new ActionError(
            "Release asset redirect is outside its official download origin.",
          );
        if (response.body) await response.body.cancel();
        response = await fetch(location, {
          headers: {
            Accept: "application/octet-stream",
            "User-Agent": "nddev-ci",
          },
          redirect: "error",
          signal,
        });
      }
    } catch (error) {
      if (error instanceof ActionError) throw error;
      // A failed fetch has no HTTP result; the API redirect belongs to the previous request.
      response = undefined;
      if (attempt === 3)
        throw new ActionError(
          "Pinned release asset transport did not complete.",
        );
    }
    if (response?.ok) break;
    const transient =
      response === undefined ||
      [408, 429, 500, 502, 503, 504].includes(response.status);
    if (!transient || attempt === 3)
      throw new ActionError(
        `Pinned release asset download failed: HTTP ${response?.status ?? "unavailable"}.`,
      );
    const requested = Number(response?.headers.get("retry-after") ?? 0);
    if (Number.isFinite(requested) && requested > 30)
      throw new ActionError(
        "Pinned release asset source requested a later retry.",
      );
    if (response?.body) await response.body.cancel();
    console.log(
      `Transient asset transport ${response?.status ?? "unavailable"}; retrying the same pinned source (${attempt + 1}/3).`,
    );
    await delay(
      Math.max(2 ** attempt, Number.isFinite(requested) ? requested : 0) * 1000,
    );
    response = undefined;
  }
  if (!response.body)
    throw new ActionError("Pinned release asset response has no body.");
  const checksum = createHash("sha256");
  let size = 0;
  const output = openSync(destination, "wx", 0o600);
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > asset.size)
        throw new ActionError("Release asset exceeds its published size.");
      checksum.update(chunk);
      let written = 0;
      while (written < chunk.length)
        written += writeSync(output, chunk, written, chunk.length - written);
    }
    if (size !== asset.size)
      throw new ActionError("Release asset response is incomplete.");
    if (checksum.digest("hex") !== asset.sha256)
      throw new ActionError("Release asset digest differs from its pin.");
  } finally {
    closeSync(output);
  }
}
