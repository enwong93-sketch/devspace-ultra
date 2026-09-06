import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtime = await readFile(new URL("./devspace-stable-gateway.mjs", import.meta.url), "utf8");
const controller = await readFile(new URL("../dist/stable-gateway-controller.js", import.meta.url), "utf8");
const proxy = await readFile(new URL("../dist/stable-gateway-proxy.js", import.meta.url), "utf8");

assert.match(runtime, /createStableGatewayActivityJournal/, "Gateway runtime must own the activity journal so it survives Core restarts");
assert.match(runtime, /handleStableGatewayLiveRequest/, "Gateway runtime must serve the local live UI itself");
assert.match(runtime, /stateDir:\s*options\.controllerOptions\.stateDir/, "Local UI must read the canonical backend state directory directly");
assert.match(runtime, /activityJournal/, "Gateway runtime must pass one shared journal through the control plane");
assert.match(controller, /activityJournal/, "Controller must pass the Gateway-owned journal into the proxy");
assert.match(proxy, /startToolCall/, "Proxy must mirror tools\/call start events into the journal");
assert.match(proxy, /finishToolCall/, "Proxy must mirror tools\/call terminal events into the journal");
assert.doesNotMatch(runtime, /Page\.reload|location\.reload|session\.reload/, "Local live UI integration must never reload ChatGPT");

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-live-ui-static", gatewayOwned: true, noChatGptReload: true }));
