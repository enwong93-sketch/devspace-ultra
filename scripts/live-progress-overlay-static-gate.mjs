import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const overlay = await readFile(new URL("./devspace-live-progress-overlay.ps1", import.meta.url), "utf8");
const helper = await readFile(new URL("./devspace-progress.mjs", import.meta.url), "utf8");
const gateway = await readFile(new URL("./devspace-stable-gateway.mjs", import.meta.url), "utf8");

assert.match(overlay, /Topmost="True"/, "desktop assistant-progress UI must be always-on-top");
assert.match(overlay, /Background="#FFFFFF"/, "desktop assistant-progress UI must use a white surface");
assert.match(overlay, /TranscriptText/, "overlay must render the natural-language assistant transcript");
assert.match(overlay, /ScrollViewer/, "natural-language transcript must remain readable when it grows");
assert.match(overlay, /devspace-live-progress\.json/, "desktop progress UI must read the durable human progress state directly");
assert.match(overlay, /progressStatePath/, "desktop progress UI must discover the durable state path from Gateway control metadata when available");
assert.match(overlay, /devspace-goal-run-live\.json/, "desktop progress UI must merge backend-owned Goal run heartbeat without depending on ChatGPT Classic rendering");
assert.match(overlay, /heartbeat/, "desktop progress UI must surface stale backend heartbeat while retaining the last confirmed progress");
assert.doesNotMatch(overlay, /GetStringAsync|HttpClient/, "desktop progress UI must never block the WPF dispatcher on Gateway HTTP polling");
assert.match(overlay, /Width="460"/);
assert.match(overlay, /CornerRadius="16"/);
assert.doesNotMatch(overlay, /WorkingDot|CompletedPanel|&#27491;&#22312;&#36914;&#34892;|&#26368;&#36817;&#23436;&#25104;/, "status-board sections must not return to the user-facing UI");
assert.doesNotMatch(overlay, /toolName|activePid|gatewaySessions|__devspace\/live\/snapshot|HTTP\s+[0-9]/i, "desktop user UI must not expose engineering/debug vocabulary");
assert.match(helper, /--message/, "agent helper must support proactive natural-language messages");
assert.match(helper, /messageCount/, "helper must report natural-language stream state");
assert.match(gateway, /handleStableGatewayHumanProgressRequest/);
assert.match(gateway, /createStableGatewayHumanProgress/);
assert.doesNotMatch(overlay, /Page\.reload|location\.reload|chatgpt\.com/i, "desktop overlay must never control the ChatGPT renderer");

console.log(JSON.stringify({ ok: true, gate: "live-progress-overlay-static", whiteFloatingUi: true, naturalLanguageStream: true, durableStateDirect: true, backendOwnedHeartbeat: true, noStatusBoard: true, noChatGptControl: true }));
