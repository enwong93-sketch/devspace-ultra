import assert from "node:assert/strict";
import { proxyRequest } from "./index.js";

const origin = "https://devspace-origin.example";

async function testForwardMcpRequest() {
  const calls = [];
  const fetchImpl = async (request) => {
    calls.push({
      url: request.url,
      method: request.method,
      redirect: request.redirect,
      authorization: request.headers.get("authorization"),
      accept: request.headers.get("accept"),
      mcpSessionId: request.headers.get("mcp-session-id"),
      host: request.headers.get("host"),
      forwardedHost: request.headers.get("x-forwarded-host"),
      cfConnectingIp: request.headers.get("cf-connecting-ip"),
      body: await request.text(),
    });
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer resource_metadata=\"https://edge.example/.well-known/oauth-protected-resource/mcp\"",
      },
    });
  };

  const response = await proxyRequest(new Request("https://edge.example/mcp?probe=1", {
    method: "POST",
    headers: {
      Authorization: "Bearer diagnostic-token",
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "Mcp-Session-Id": "session-123",
      "X-Forwarded-Host": "spoofed.example",
      "CF-Connecting-IP": "203.0.113.1",
    },
    body: "{\"jsonrpc\":\"2.0\"}",
  }), { ORIGIN_BASE_URL: origin }, fetchImpl);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${origin}/mcp?probe=1`);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].redirect, "manual");
  assert.equal(calls[0].authorization, "Bearer diagnostic-token");
  assert.equal(calls[0].accept, "application/json, text/event-stream");
  assert.equal(calls[0].mcpSessionId, "session-123");
  assert.equal(calls[0].host, null);
  assert.equal(calls[0].forwardedHost, null);
  assert.equal(calls[0].cfConnectingIp, null);
  assert.equal(calls[0].body, "{\"jsonrpc\":\"2.0\"}");
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer resource_metadata=\"https://edge.example/.well-known/oauth-protected-resource/mcp\"");
}

async function testAllowedPublicSurfaces() {
  const allowed = [
    "/",
    "/healthz",
    "/mcp",
    "/authorize",
    "/token",
    "/register",
    "/revoke",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/",
    "/.well-known/openid-configuration",
    "/mcp-app-assets/app.js",
  ];
  for (const pathname of allowed) {
    let called = false;
    const response = await proxyRequest(new Request(`https://edge.example${pathname}`), { ORIGIN_BASE_URL: origin }, async (request) => {
      called = true;
      assert.equal(new URL(request.url).pathname, pathname);
      return new Response("ok", { status: 200 });
    });
    assert.equal(called, true, `expected ${pathname} to reach origin`);
    assert.equal(response.status, 200);
  }
}

async function testDeniedSurfacesNeverReachOrigin() {
  const denied = [
    "/browser-control/bridge/next",
    "/healthz/private",
    "/foo",
    "/mcp-other",
    "/../browser-control/bridge/pair",
  ];
  for (const pathname of denied) {
    let calls = 0;
    const response = await proxyRequest(new Request(`https://edge.example${pathname}`), { ORIGIN_BASE_URL: origin }, async () => {
      calls += 1;
      return new Response("unexpected", { status: 200 });
    });
    assert.equal(calls, 0, `denied path reached origin: ${pathname}`);
    assert.equal(response.status, 404);
  }
}

async function testAuthorizeRedirectIsNotFollowed() {
  const callback = "https://chatgpt.com/connector/oauth/test-callback?code=opaque&state=opaque";
  let redirectMode = null;
  const response = await proxyRequest(new Request("https://edge.example/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "owner_token=redacted",
  }), { ORIGIN_BASE_URL: origin }, async (request) => {
    redirectMode = request.redirect;
    return new Response(null, { status: 302, headers: { Location: callback } });
  });

  assert.equal(redirectMode, "manual");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), callback);
}

async function testVcpServiceBindingIsPreferredOverPublicOrigin() {
  const calls = [];
  const env = {
    PRIVATE_ORIGIN: {
      async fetch(request) {
        calls.push({ url: request.url, method: request.method, redirect: request.redirect });
        return new Response("private-ok", { status: 200 });
      },
    },
    ORIGIN_BASE_URL: "https://should-not-be-used.example",
  };
  const response = await proxyRequest(new Request("https://edge.example/mcp?via=vpc"), env, async () => {
    throw new Error("public fetchImpl must not run when PRIVATE_ORIGIN is bound");
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "private-ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1/mcp?via=vpc");
  assert.equal(calls[0].redirect, "manual");
}

async function testOriginMustBeFixedHttpsBase() {
  await assert.rejects(
    () => proxyRequest(new Request("https://edge.example/mcp"), { ORIGIN_BASE_URL: "http://127.0.0.1:7676" }, async () => new Response("ok")),
    /HTTPS origin/i,
  );
  await assert.rejects(
    () => proxyRequest(new Request("https://edge.example/mcp"), { ORIGIN_BASE_URL: "https://origin.example/path" }, async () => new Response("ok")),
    /origin base URL/i,
  );
}

await testForwardMcpRequest();
await testAllowedPublicSurfaces();
await testDeniedSurfacesNeverReachOrigin();
await testAuthorizeRedirectIsNotFollowed();
await testVcpServiceBindingIsPreferredOverPublicOrigin();
await testOriginMustBeFixedHttpsBase();

console.log(JSON.stringify({ ok: true, gate: "fixed-edge-worker", tests: 7 }));
