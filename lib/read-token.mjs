import { createPrivateKey, sign } from "node:crypto";

// A GitHub App installation token that reads only the contents of named repositories of the
// caller's own organization. The token is checked to hold exactly that before it is returned, and
// a token that holds more or other is revoked at once.
const refuse = (message) => { throw new Error(message); };

/** The owner/repository names asked for, as names inside the caller's organization. */
export function repositories(requested, owner) {
  const names = String(requested ?? "").split(/\s+/).filter(Boolean).map((fullName) => {
    const parts = fullName.split("/");
    if (parts.length !== 2 || parts[0].toLowerCase() !== owner.toLowerCase() || !/^[a-zA-Z0-9_.-]+$/.test(parts[1]))
      refuse("Every read repository must belong to the caller organization");
    return parts[1];
  });
  if (!names.length) refuse("App installation and explicit read repositories are required");
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) refuse("Duplicate read repositories");
  return names;
}

function jwt(clientId, privateKey, now) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "rsa") refuse("The App key must be RSA");
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = encode({alg: "RS256", typ: "JWT"}) + "." + encode({iat: now - 60, exp: now + 540, iss: clientId});
  return unsigned + "." + sign("sha256", Buffer.from(unsigned), key).toString("base64url");
}

function client(api, fetchImpl) {
  return async (path, token, method = "GET", body) => {
    const response = await fetchImpl(api + path, {
      method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
        "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28"},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) refuse("GitHub App request failed with status " + response.status);
    return response.status === 204 ? undefined : response.json();
  };
}

/** Mints the token and returns it with the count of repositories it reads. */
export async function mint({clientId, installationId, requested, privateKey, owner, api, fetchImpl = fetch, mask = () => {},
  now = Math.floor(Date.now() / 1000)}) {
  const installation = Number(installationId);
  if (!Number.isSafeInteger(installation) || installation <= 0) refuse("App installation and explicit read repositories are required");
  const names = repositories(requested, owner);
  const expected = new Set(names.map((name) => name.toLowerCase()));
  const request = client(api, fetchImpl);
  const signed = jwt(clientId, privateKey, now);
  mask(signed);
  const installed = await request("/app/installations/" + installation, signed);
  if (installed?.account?.login?.toLowerCase() !== owner.toLowerCase()) refuse("The App installation belongs to another organization");
  const granted = await request("/app/installations/" + installation + "/access_tokens", signed, "POST",
    {repositories: names, permissions: {contents: "read"}});
  mask(granted.token);
  try {
    if (granted.permissions?.contents !== "read" || Object.entries(granted.permissions).some(
      ([name, access]) => !["contents", "metadata"].includes(name) || access !== "read"))
      refuse("The granted token is not contents-read only");
    const actual = new Set();
    for (let page = 1; actual.size < expected.size; page++) {
      const scope = await request("/installation/repositories?per_page=100&page=" + page, granted.token);
      if (scope.total_count !== expected.size || !scope.repositories?.length)
        refuse("The granted repository scope differs from the explicit request");
      const previous = actual.size;
      for (const repository of scope.repositories) {
        if (repository.owner.login.toLowerCase() !== owner.toLowerCase() || !expected.has(repository.name.toLowerCase()))
          refuse("The token can read an unrequested repository");
        actual.add(repository.name.toLowerCase());
      }
      if (actual.size === previous) refuse("Repository scope pagination did not advance");
    }
    return {token: granted.token, count: actual.size};
  } catch (error) {
    await request("/installation/token", granted.token, "DELETE");
    throw error;
  }
}
