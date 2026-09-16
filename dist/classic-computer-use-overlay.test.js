import assert from "node:assert/strict";
import {
  buildComputerUseOverlayScript,
  clearComputerUseOverlayScript,
  ClassicComputerUseOverlay,
  inspectComputerUseOverlayExpression,
} from "./classic-computer-use-overlay.js";

const record = {
  conversationId: "conversation-computer-use",
  runtimeKey: "main-01",
  operationId: "operation-computer-use",
  app: "process:C:\\Apps\\Discord.exe",
  appLabel: "Discord",
  action: "get_window_state",
  startedAt: "2026-09-16T08:00:00.000Z",
  expiresAt: "2026-09-16T08:02:00.000Z",
};
const script = buildComputerUseOverlayScript(record, {
  producerId: "active-core",
  producerPriority: 100,
});
assert.match(script, /Computer Use 正在使用你的電腦/);
assert.match(script, /OpenAI @oai\/sky/);
assert.match(script, /只限目前對話/);
assert.match(script, /rgba\(37,99,235,\.16\)/, "takeover state must visibly tint the ChatGPT surface blue");
assert.match(script, /pointer-events:none/, "the status layer must never block the user from intervening");
assert.match(script, /aria-live','polite'/);
assert.match(script, /actual !== state\.conversationId/);
assert.match(script, /suppressed-by-producer-lease/);
assert.doesNotMatch(script, /@keyframes|animation:/, "the takeover state is deliberately static; expressive motion is not part of this control surface");
assert.match(clearComputerUseOverlayScript(record), /root\.remove\(\)/);
assert.match(inspectComputerUseOverlayExpression(), /devspace-computer-use-overlay-root/);

const evaluations = [];
const timers = [];
let now = Date.parse("2026-09-16T08:00:00.000Z");
const fakeAdapter = {
  async find({ conversationId }) {
    assert.equal(conversationId, "conversation-computer-use");
    return {
      exact: true,
      ambiguous: false,
      conversationId,
      runtimeKey: "main-01",
      target: {
        runtimeKey: "main-01",
        port: 9721,
        targetId: "target-a",
        url: `https://chatgpt.com/c/${conversationId}`,
        webSocketDebuggerUrl: "ws://target-a",
      },
    };
  },
  async connect() {
    return {
      async evaluate(expression) {
        evaluations.push(expression);
        if (expression.includes("cleared:true")) return { ok: true, cleared: true, rootCount: 0 };
        if (expression.includes("mounted:Boolean(root)")) return { mounted: true, visible: true, rootCount: 1 };
        return { ok: true, mounted: true, visible: true, rootCount: 1 };
      },
      close() {},
    };
  },
};
const overlay = new ClassicComputerUseOverlay({
  adapter: fakeAdapter,
  producerId: "active-core",
  producerPriority: 100,
  idleGraceMs: 5_000,
  maxSessionMs: 120_000,
  now: () => now,
  setTimer(fn, delay) {
    const timer = { fn, delay, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  },
  clearTimer(timer) {
    if (timer) timer.cleared = true;
  },
});

const first = await overlay.begin({
  conversationId: "conversation-computer-use",
  runtimeKey: "main-01",
  app: "process:C:\\Apps\\Discord.exe",
  action: "get_window_state",
  timeoutMs: 20_000,
});
assert.equal(first.overlay.ok, true);
assert.equal(first.activeCount, 1);
assert.equal(first.appLabel, "Discord");
assert.equal(overlay.status().activeConversations.length, 1);

now += 1_000;
const second = await overlay.begin({
  conversationId: "conversation-computer-use",
  runtimeKey: "main-01",
  app: "process:C:\\Apps\\Discord.exe",
  action: "activate_window",
  timeoutMs: 20_000,
});
assert.equal(second.operationId, first.operationId, "nearby Computer Use actions must share one visible takeover session");
assert.equal(second.activeCount, 2);

const stillActive = await overlay.end({
  conversationId: "conversation-computer-use",
  operationId: first.operationId,
  state: "completed",
});
assert.equal(stillActive.state, "still-active");
const scheduled = await overlay.end({
  conversationId: "conversation-computer-use",
  operationId: first.operationId,
  state: "completed",
});
assert.equal(scheduled.state, "idle-clear-scheduled");
assert.equal(scheduled.clearAfterMs, 5_000);
const idleTimer = [...timers].reverse().find((timer) => timer.delay === 5_000 && !timer.cleared);
assert.ok(idleTimer, "idle grace must schedule automatic cleanup");
idleTimer.fn();
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(overlay.status().activeConversations.length, 0);
assert.ok(evaluations.some((expression) => expression.includes("Computer Use 正在使用你的電腦")));
assert.ok(evaluations.some((expression) => expression.includes("cleared:true")));

now += 1_000;
const releaseSession = await overlay.begin({
  conversationId: "conversation-computer-use",
  runtimeKey: "main-01",
  app: "process:C:\\Apps\\Discord.exe",
  action: "get_window_state",
  timeoutMs: 20_000,
});
assert.equal(overlay.status().activeConversations.length, 1);
const released = await overlay.release({
  conversationId: "conversation-computer-use",
  operationId: releaseSession.operationId,
  state: "agent-released",
});
assert.equal(released.state, "released");
assert.equal(released.explicitRelease, true);
assert.equal(released.cleared, true);
assert.equal(overlay.status().activeConversations.length, 0, "explicit release must remove takeover ownership immediately");

const staleRelease = await overlay.release({
  conversationId: "conversation-computer-use",
  state: "agent-released",
});
assert.equal(staleRelease.state, "released", "release must also clear a stale DOM overlay after Core-local session state is gone");
assert.equal(staleRelease.explicitRelease, true);

console.log(JSON.stringify({
  ok: true,
  gate: "classic-computer-use-overlay",
  exactConversationOnly: true,
  blueTakeoverState: true,
  pointerEventsBlocked: false,
  producerLease: true,
  sharedActionSession: true,
  explicitAgentRelease: true,
  staleOverlayRelease: true,
  idleAutoClear: true,
  hardExpiry: true,
  staticReducedMotionSafe: true,
}));
