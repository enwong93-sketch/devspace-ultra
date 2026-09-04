import assert from "node:assert/strict";
import { requestPath } from "./logger.js";

assert.equal(
  requestPath({
    originalUrl: "/.well-known/oauth-authorization-server/?probe=1",
    path: "/",
    url: "/?probe=1",
  }),
  "/.well-known/oauth-authorization-server/",
  "requestPath must preserve the original mounted-router pathname while stripping query data",
);

assert.equal(
  requestPath({ path: "/mcp", url: "/mcp?x=1" }),
  "/mcp",
  "requestPath must keep the existing non-router fallback",
);

console.log(JSON.stringify({ ok: true, gate: "logger-request-path" }));
