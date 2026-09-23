import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const observer = await readFile(new URL("../dist/classic-turn-transport-observer.js", import.meta.url), "utf8");
const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
const guard = await readFile(new URL("../dist/goal-round-completion-guard.js", import.meta.url), "utf8");

assert.match(observer, /Network\.enable/);
assert.match(observer, /requestWillBeSent/);
assert.match(observer, /requestWillBeSentExtraInfo/);
assert.match(observer, /loadingFailed/);
assert.match(observer, /loadingFinished/);
assert.match(observer, /parseNativeCallMcpRequest/);
assert.match(observer, /onNativeMcpCall/);
assert.match(observer, /Network\.getRequestPostData/);
assert.match(observer, /Network\.streamResourceContent/);
assert.match(observer, /Network\.dataReceived/);
assert.match(observer, /isNativeCallMcpRequest/);
assert.match(observer, /\/backend-api\/f\/conversation\/resume/, "hidden Goal continuation turns must remain observable through the native resume transport");
assert.doesNotMatch(observer, /Runtime\.enable|Runtime\.evaluate|client\.call\("Page\.(?:reload|navigate)"|Network\.getResponseBody/, "always-on delivery observer must stay network-only and low-memory");
assert.match(observer, /maxPending/);
assert.match(observer, /pendingTtlMs/);
assert.match(server, /const configuredClassicPorts = Array\.isArray\(config\.classicMainDebugPorts\)[\s\S]{0,260}const classicCdpOptions = \{[\s\S]{0,220}configuredClassicPorts\.length[\s\S]{0,120}defaultMainDebugPorts\(\{ includeObserved: true, refresh: true \}\)/,
  "server must prefer explicit bounded ports and otherwise merge observed process ports with canonical fallbacks");
assert.match(server, /new ClassicTurnTransportObserver\(classicCdpOptions\)/, "always-on native observer must use the configured bounded Classic port set");
assert.match(server, /turnTransportObserver\.start\(\)/);
assert.match(server, /turnTransportObserver\.close\(\)/);
assert.match(server, /sessionFingerprintFromClassicRequest/);
assert.match(server, /resolveAndBindMcpConversation/);
assert.match(server, /goalRuntime\.bindConversation/);
assert.match(server, /ClassicMcpCallCorrelator/);
assert.match(server, /fingerprintMcpToolCall\(req\?\.body\)/);
assert.match(guard, /DEFAULT_NATIVE_COMPLETE_GRACE_MS/);
assert.match(guard, /nativeCompleteStableMs/);
assert.match(guard, /currentTurnTransportFinished/,
  "stale GUI generating may be overridden only by current-round transport-finished evidence");
assert.match(guard, /sawCurrentRoundAssistant/,
  "stale GUI generating may be overridden only after the current round produced an assistant message");
assert.match(guard, /safetyCheckVisible !== true/);

console.log(JSON.stringify({
  ok: true,
  gate: "classic-turn-transport-observer-static",
  alwaysOnNativeTransport: true,
  networkOnly: true,
  bounded: true,
  automaticGoalConversationBinding: true,
  nativeCallMcpCorrelation: true,
  streamedToolInvocationCorrelation: true,
  goalContinuationResumeObserved: true,
  staleGuiGeneratingRequiresCurrentTurnProof: true,
  safetyCheckFailsClosed: true,
}));
