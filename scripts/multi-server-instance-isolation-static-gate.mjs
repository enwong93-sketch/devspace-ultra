import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [config, server, setup, overlay, resolver] = await Promise.all([
  readFile(new URL("../dist/config.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("./devspace-public-setup.ps1", import.meta.url), "utf8"),
  readFile(new URL("../dist/classic-progress-narration-overlay.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/conversation-start-claim-cdp.js", import.meta.url), "utf8"),
]);

assert.match(config, /serverInstanceId:\s*parseServerInstanceId/);
assert.match(config, /new URL\("\/mcp", publicBaseUrl\)/,
  "fallback instance identity must be derived from the exact public MCP resource");
assert.match(setup, /serverInstanceId/);
assert.match(setup, /\[guid\]::NewGuid\(\)/,
  "each fresh public installation must persist an independent server instance id");
assert.match(server, /checkResourceAllowed\(\{ requestedResource: req\.auth\.resource, configuredResource: resourceServerUrl \}\)/,
  "OAuth audience must remain bound to this exact public MCP resource");
assert.match(server, /devspace_instance_binding_required/);
assert.match(server, /currentInvocationVerified:\s*true/);
assert.match(server, /progressBootstrapAuthority\?\.consumeCapability/,
  "an exact progress claim must unlock ordinary same-turn tools without per-tool manual rebinding");
assert.match(server, /traceCorrelationFingerprints:\s*requestTraceCorrelationFingerprints/,
  "the capability lease must remain bound to the exact ChatGPT turn trace");
assert.match(server, /chatGptConnectorRequest[\s\S]{0,1600}!exactAuthority\?\.conversationId[\s\S]{0,500}!exactLocalInvocation/,
  "non-bootstrap ChatGPT calls must fail closed without a current exact local invocation");
assert.match(server, /serverInstanceId:\s*config\.serverInstanceId[\s\S]{0,200}resourceOrigin:/,
  "persisted App origins must be scoped by both server instance and public resource origin");
assert.match(server, /relayOriginProbeToken\s*=\s*randomUUID\(\)/);
assert.match(server, /__devspace\/relay-origin-probe\?t=/);
assert.match(server, /token !== relayOriginProbeToken/,
  "an arbitrary second Connector must not be able to register its App origin against this instance");
assert.match(server, /access-control-allow-origin/);
assert.match(server, /progressClaimRelayHtml\(relayOriginProbeUrl\)/,
  "the token-bound origin probe must be injected only into this server's relay resource");
assert.match(overlay, /ownedRelayFrame/);
assert.match(overlay, /RELAY_APP_ORIGINS/);
assert.match(resolver, /existingOwner\.appSandboxOrigin !== appSandboxOrigin/,
  "one claim observed through two Connector Apps must fail closed");

console.log(JSON.stringify({
  ok: true,
  gate: "multi-server-instance-isolation-static",
  independentPublicResources: true,
  persistedServerInstanceId: true,
  oauthAudienceBound: true,
  exactLocalInvocationRequired: true,
  exactProgressTurnCapabilityLease: true,
  connectorAppOriginBound: true,
  tokenBoundOriginProbe: true,
  crossComputerFailClosed: true,
}));
