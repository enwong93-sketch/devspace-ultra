import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SingleUserOAuthProvider } from "./oauth-provider.js";

const stateDir = mkdtempSync(join(tmpdir(), "devspace-oauth-provider-"));
const resource = new URL("https://edge.example/mcp");
const redirectUri = "http://127.0.0.1/callback";
const config = {
  ownerToken: "0123456789abcdef0123456789abcdef",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
  scopes: ["devspace"],
  allowedRedirectHosts: ["chatgpt.com", "localhost", "127.0.0.1"],
};

function fakeAuthorizeResponse() {
  return {
    req: { method: "POST", body: { owner_token: config.ownerToken } },
    statusCode: 200,
    redirectLocation: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() { return this; },
    send() { return this; },
    redirect(code, location) {
      this.statusCode = code;
      this.redirectLocation = location;
      return this;
    },
  };
}

let providerA;
let providerB;
try {
  providerA = new SingleUserOAuthProvider(config, resource, stateDir);
  const client = providerA.clientsStore.registerClient({
    client_name: "OAuth handover test",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  const response = fakeAuthorizeResponse();
  await providerA.authorize(client, {
    resource,
    scopes: ["devspace"],
    redirectUri,
    codeChallenge: "pkce-challenge-opaque",
    state: "state-opaque",
  }, response);
  assert.equal(response.statusCode, 302);
  const code = new URL(response.redirectLocation).searchParams.get("code");
  assert.ok(code?.startsWith("code-"));
  providerA.close();
  providerA = null;

  providerB = new SingleUserOAuthProvider(config, resource, stateDir);
  assert.equal(
    await providerB.challengeForAuthorizationCode(client, code),
    "pkce-challenge-opaque",
    "authorization code challenge must survive a backend/provider handover",
  );
  const tokenPair = await providerB.exchangeAuthorizationCode(client, code, undefined, redirectUri, resource);
  assert.ok(tokenPair.access_token);
  assert.ok(tokenPair.refresh_token);
  await assert.rejects(
    () => providerB.exchangeAuthorizationCode(client, code, undefined, redirectUri, resource),
    /Invalid authorization code/,
    "authorization code must remain one-time after persistent handover-safe exchange",
  );
  providerB.close();
  providerB = null;

  console.log(JSON.stringify({ ok: true, gate: "oauth-provider-handover", replayBlocked: true }));
} finally {
  try { providerA?.close(); } catch {}
  try { providerB?.close(); } catch {}
  rmSync(stateDir, { recursive: true, force: true });
}
