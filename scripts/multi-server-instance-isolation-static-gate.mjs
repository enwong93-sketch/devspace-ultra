import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [config, server, setup, overlay, resolver, providerBinding, progressBootstrap] = await Promise.all([
  readFile(new URL("../dist/config.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("./devspace-public-setup.ps1", import.meta.url), "utf8"),
  readFile(new URL("../dist/classic-progress-narration-overlay.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/conversation-start-claim-cdp.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/openai-conversation-binding.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/progress-bootstrap-authority.js", import.meta.url), "utf8"),
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
assert.match(server, /resolveRequestCapabilityAuthority/,
  "the instance gate must wait for bounded late exact correlation before rejecting a stateful tool");
assert.match(server, /allowLateCorrelation:\s*Boolean\(requestConversation\?\.openaiIdentity\)/,
  "only authenticated provider-conversation requests may wait for late page correlation");
assert.match(server, /lateCorrelationTimeoutMs:\s*MCP_CONVERSATION_CORRELATION_TIMEOUT_MS \+ 2_000/,
  "late exact correlation must remain wall-clock bounded");
assert.match(progressBootstrap, /progressBootstrapAuthority\.consumeCapability/,
  "an exact progress claim must unlock ordinary same-turn tools without per-tool manual rebinding");
assert.match(server, /refreshCapabilityLease/,
  "verified work must keep the fresh-chat claim lease alive across host session aliases");
assert.match(progressBootstrap, /request traces remain disjoint[\s\S]{0,160}trace collision fails closed/i,
  "reusable host transports must select one trace owner and fail closed on trace collision");
assert.match(server, /verifyConversationPage:\s*verifyProgressCapabilityConversationPage/,
  "ordinary tools must outlive the bounded hidden relay by reverifying the exact physical conversation page");
assert.match(server, /callFingerprint:\s*requestCallFingerprint/,
  "claim-derived authority must retain the current call fingerprint so a rotated provider alias can be bound");
assert.match(server, /requestTraceCorrelationFingerprints\(req\?\.headers/,
  "the capability lease must remain bound to exact request traces");
assert.match(server, /if \(!exactAuthority\?\.conversationId[\s\S]{0,500}!exactLocalInvocation\)/,
  "non-bootstrap ChatGPT calls must fail closed without an exact local proof");
assert.match(server, /verifiedLocalProviderBinding\(providerAuthority, providerIdentity\)/,
  "a previously proved conversation must retain ordinary tools after reconnect");
assert.match(server, /verifiedLocalProviderBinding\(exactAuthority, requestConversation\?\.openaiIdentity\)/,
  "the ordinary-tool gate must accept freshly checked provider conversation ownership");
assert.match(server, /inspectBoundProviderConversationPage[\s\S]{0,500}progressLivenessAdapter\.find\(\{ conversationId \}\)/,
  "provider alias reuse must re-check the globally exact physical conversation page");
assert.match(server, /page\?\.exact !== true \|\| page\?\.ambiguous === true/,
  "duplicate exact pages must invalidate provider alias reuse");
assert.match(server, /page\?\.duplicatePageObserved === true/,
  "even a uniquely active copy of a duplicated conversation remains rejected for provider authority");
assert.match(server, /hasOpenaiProviderMetadata/,
  "authenticated OpenAI provider metadata, not only a mutable User-Agent, must activate the instance gate");
assert.match(server, /bootstrapTools:\s*\["devspace_progress_report", "devspace_progress_bind"/,
  "the binding error must expose the actual one-time progress bind action");
assert.match(providerBinding, /authority\?\.providerConversationKey === key/);
assert.match(providerBinding, /authority\?\.pageVerified === true/);
assert.match(providerBinding, /version:\s*this\.serverInstanceId \? 2 : 1/,
  "persisted provider-conversation bindings must carry a server-instance-scoped schema");
assert.match(providerBinding, /data\.serverInstanceId !== this\.serverInstanceId/,
  "a retained OAuth resource cannot borrow provider bindings from another logical server instance");
assert.match(server, /serverInstanceId:\s*config\.serverInstanceId[\s\S]{0,120}OpenaiConversationBindings|OpenaiConversationBindings\([\s\S]{0,220}serverInstanceId:\s*config\.serverInstanceId/,
  "the live binding registry must receive the current server instance id");
assert.match(providerBinding, /authenticated-current-invocation-exact-page/,
  "a late exact invocation must bind a rotated provider alias only after local page verification");
assert.match(server, /serverInstanceId:\s*config\.serverInstanceId[\s\S]{0,200}resourceOrigin:/,
  "persisted App origins must be scoped by both server instance and public resource origin");
assert.match(server, /providerBindings:\s*openaiBindings\.status\(\)/,
  "loopback memory diagnostics must expose only the secret-free provider-binding status for live continuity debugging");
assert.match(progressBootstrap, /capabilityConversationPageVerified/,
  "lease diagnostics must distinguish direct exact-page keepalive after hidden relay retirement");
assert.match(progressBootstrap, /nearestExpiryMs/,
  "lease diagnostics must expose bounded expiry timing without conversation ids or raw traces");
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
  verifiedProviderConversationRecovery: true,
  providerBindingStoreInstanceScoped: true,
  providerBindingDiagnostics: true,
  exactProgressTurnCapabilityLease: true,
  lateExactCorrelationWaited: true,
  lateCorrelationBounded: true,
  freshChatLeaseKeepalive: true,
  hiddenRelayExpiryTolerated: true,
  traceSelectedReusableTransport: true,
  rotatedProviderAliasBound: true,
  providerReuseGloballyUniquePage: true,
  connectorAppOriginBound: true,
  tokenBoundOriginProbe: true,
  crossComputerFailClosed: true,
}));
