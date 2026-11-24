import assert from "node:assert/strict";
import test from "node:test";
import { revokeToken } from "../actions/revoke-token/run.mjs";
import { runStep } from "../actions/hosted-sdk-step/run.mjs";

test("revokeToken sends DELETE /installation/token and tolerates 401", async () => {
  const calls = [];
  const ok = await revokeToken("ghs_secret", "https://api.github.com/", async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization });
    return { status: 204, ok: true };
  });
  assert.equal(ok, "revoked");
  assert.deepEqual(calls, [{ url: "https://api.github.com/installation/token", method: "DELETE", auth: "Bearer ghs_secret" }]);

  const expired = await revokeToken("ghs_old", "https://api.github.com", async () => ({ status: 401, ok: false }));
  assert.equal(expired, "already-revoked");

  await assert.rejects(
    revokeToken("ghs_fail", "https://api.github.com", async () => ({ status: 500, ok: false })),
    /HTTP 500/,
  );
});

test("hosted-sdk step wrapper rejects unknown commands", async () => {
  await assert.rejects(runStep("unknown"), /Unknown hosted SDK helper step/);
});
