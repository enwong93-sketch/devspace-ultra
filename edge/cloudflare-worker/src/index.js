const EXACT_PUBLIC_PATHS = new Set([
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
  "/.well-known/openid-configuration",
]);

const STRIPPED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);

function publicPathAllowed(pathname) {
  const exactPath = pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
  return EXACT_PUBLIC_PATHS.has(exactPath) || pathname.startsWith("/mcp-app-assets/");
}

function fixedOriginUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    throw new Error("ORIGIN_BASE_URL must be a valid HTTPS origin base URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("ORIGIN_BASE_URL must use an HTTPS origin.");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("ORIGIN_BASE_URL must be an origin base URL without credentials, path, query, or fragment.");
  }
  url.pathname = "/";
  return url;
}

function forwardedHeaders(input) {
  const headers = new Headers();
  for (const [name, value] of input.entries()) {
    const lower = name.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith("cf-")) continue;
    headers.append(name, value);
  }
  return headers;
}

function upstreamRequest(request, origin) {
  const incoming = new URL(request.url);
  const target = new URL(origin.href);
  target.pathname = incoming.pathname;
  target.search = incoming.search;

  // Construct from the original Request so streaming bodies remain streaming,
  // then replace only the forwarding-sensitive headers and redirect policy.
  const retargeted = new Request(target.href, request);
  return new Request(retargeted, {
    headers: forwardedHeaders(request.headers),
    redirect: "manual",
  });
}

function privateUpstreamRequest(request) {
  const incoming = new URL(request.url);
  // VPC Service configuration, not this URL host, determines the actual target.
  // Use loopback as the HTTP Host so the local DevSpace host allowlist accepts
  // the private hop without needing any contributor-specific public hostname.
  const target = new URL("http://127.0.0.1");
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const retargeted = new Request(target.href, request);
  return new Request(retargeted, {
    headers: forwardedHeaders(request.headers),
    redirect: "manual",
  });
}

export async function proxyRequest(request, env, fetchImpl = fetch) {
  const incoming = new URL(request.url);
  if (!publicPathAllowed(incoming.pathname)) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  if (env?.PRIVATE_ORIGIN && typeof env.PRIVATE_ORIGIN.fetch === "function") {
    return await env.PRIVATE_ORIGIN.fetch(privateUpstreamRequest(request));
  }

  const origin = fixedOriginUrl(env?.ORIGIN_BASE_URL);
  return await fetchImpl(upstreamRequest(request, origin));
}

export default {
  async fetch(request, env) {
    return await proxyRequest(request, env);
  },
};
