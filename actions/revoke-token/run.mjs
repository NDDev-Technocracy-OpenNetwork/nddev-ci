import path from "node:path";
import { pathToFileURL } from "node:url";

export async function revokeToken(token, apiUrl = process.env.GITHUB_API_URL || "https://api.github.com", fetchImpl = fetch) {
  if (!token) return "empty";
  const base = apiUrl.replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/installation/token`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "nddev-ci",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 204 || response.ok) {
    console.log("Scoped App read token revoked.");
    return "revoked";
  }
  if (response.status === 401) {
    console.log("Scoped App read token is already expired or revoked.");
    return "already-revoked";
  }
  throw new Error(`Failed to revoke scoped App read token (HTTP ${response.status}).`);
}

function fail(message) {
  const escaped = String(message)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
  console.error(`::error::${escaped}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  revokeToken(process.env.INPUT_TOKEN).catch((error) => fail(error.message));
}
