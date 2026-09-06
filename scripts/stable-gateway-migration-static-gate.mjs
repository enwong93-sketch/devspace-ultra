import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./migrate-tailscale-stable-gateway.mjs", import.meta.url), "utf8");

assert.match(source, /DEVSPACE_STABLE_GATEWAY_PUBLIC_BASE_URL/, "migration must accept the current self-hosted public origin instead of binding to one ingress provider");
assert.doesNotMatch(source, /const PUBLIC_BASE\s*=\s*"https:\/\/devspace-gateway\.tail/i, "migration must not hardcode the obsolete Tailscale Funnel identity");
assert.match(source, /function resolvePublicBase|resolvePublicBase\(/, "migration must resolve public identity from explicit/generic config");
assert.match(source, /Get-NetTCPConnection[\s\S]*exit 0/, "listener probe must treat no listener as a normal null result rather than a PowerShell failure");
assert.match(source, /endpointDown/, "preflight must model an already-down 7678 listener as a recoverable state");
assert.match(source, /if\s*\(before\.pid\)[\s\S]*stopLegacyPid/, "migration must only stop the legacy listener when one actually exists");
assert.match(source, /rollbackCoreNeeded/, "migration must remember that rollback Core recovery is required even when 7678 was already down before migration");
assert.match(source, /if\s*\(rollbackCoreNeeded\)[\s\S]*restoreLegacyCore/, "failed migration must restore a direct Core whenever the public service started from a non-stable state");
assert.doesNotMatch(source, /fetch\(`\$\{[^}]*PUBLIC_BASE[^}]*\}\/__devspace\/gateway\/healthz/, "public verification must not require the private Stable Gateway control surface through Caddy");
assert.match(source, /\/mcp[\s\S]*status\s*===\s*401|mcpStatus/, "public verification must prove the MCP bearer challenge through the real public ingress");
assert.match(source, /127\.0\.0\.1:[^`]*\/__devspace\/gateway\/healthz/, "Stable Gateway process identity must be verified on localhost where its private health endpoint is intentionally available");

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-migration-static", providerNeutral: true, endpointDownRecoverable: true }));
