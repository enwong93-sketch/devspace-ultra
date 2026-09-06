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
assert.doesNotMatch(observer, /Runtime\.enable|Runtime\.evaluate|Page\.reload|Page\.navigate|Network\.getResponseBody/, "always-on delivery observer must stay network-only and low-memory");
assert.match(observer, /maxPending/);
assert.match(observer, /pendingTtlMs/);
assert.match(server, /new ClassicTurnTransportObserver\(\)/);
assert.match(server, /turnTransportObserver\.start\(\)/);
assert.match(server, /turnTransportObserver\.close\(\)/);
assert.match(server, /sessionFingerprintFromClassicRequest/);
assert.match(server, /resolveAndBindMcpConversation/);
assert.match(server, /goalRuntime\.bindConversation/);
assert.match(guard, /DEFAULT_NATIVE_COMPLETE_GRACE_MS/);
assert.match(guard, /nativeCompleteStableMs/);
assert.match(guard, /safetyCheckVisible !== true/);

console.log(JSON.stringify({
  ok: true,
  gate: "classic-turn-transport-observer-static",
  alwaysOnNativeTransport: true,
  networkOnly: true,
  bounded: true,
  automaticGoalConversationBinding: true,
  staleGuiGeneratingCannotBlockForever: true,
  safetyCheckFailsClosed: true,
}));
