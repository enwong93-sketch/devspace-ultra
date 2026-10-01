import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readGoalRelayHtml } from "./goal-relay-resource.js";

function freshHost({ filename = "progress-claim-relay.html", standard = true, readyAt = 0, claimMetadata = false } = {}) {
  let now = Date.now();
  const epoch = now;
  const timers = new Map();
  const listeners = new Map();
  const sent = [];
  const tools = [];
  let sequence = 0;
  let released = 0;
  let currentGoal = { id: "goal-fresh-host", conversationId: "chat-fresh-host", status: "active",
    revision: 1, round: 1, roundState: "working", continuation: { state: "idle" } };
  const claim = { claimId: "claim-fresh-host", toolName: "devspace_goal_start",
    state: "pending", expiresAt: new Date(epoch + 90_000).toISOString() };
  const emit = (message, source = window.parent) => {
    for (const listener of [...(listeners.get("message") || [])]) listener({ source, data: message });
  };
  const result = async (name, args) => {
    tools.push({ name, args });
    if (name === "devspace_goal_start") return { structuredContent: { claimed: true, goal: currentGoal } };
    if (name === "devspace_goal_status") return { structuredContent: { goal: currentGoal } };
    if (name === "devspace_goal_continuation") {
      currentGoal = { ...currentGoal, revision: currentGoal.revision + 1, round: currentGoal.round + 1,
        roundState: "working", continuation: { state: "idle" } };
      return { structuredContent: { goal: currentGoal } };
    }
    throw new Error("unexpected tool " + name);
  };
  const window = {
    parent: {},
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    openai: standard ? undefined : { toolOutput: { conversationStartClaim: claim } },
  };
  if (standard) window.parent.postMessage = (message) => {
    sent.push(message);
    if (now - epoch < readyAt) return;
    if (message.method === "ui/initialize") {
      Promise.resolve().then(() => emit({ jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: "2026-01-26", hostCapabilities: {}, hostInfo: { name: "test-host", version: "1" }, hostContext: {} } }));
    } else if (message.method === "ui/notifications/initialized") {
      emit({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: filename === "goal-continuation-relay.html"
        ? { structuredContent: { goal: currentGoal } } : claimMetadata
        ? { structuredContent: {}, _meta: { "devspace/conversationStartClaim": claim } }
        : { structuredContent: { conversationStartClaim: claim } } });
    } else if (message.method === "tools/call") {
      result(message.params.name, message.params.arguments).then(value => emit({ jsonrpc: "2.0", id: message.id, result: value }));
    }
  };
  const document = { documentElement: { dataset: {} }, body: { replaceChildren() { released++; } }, title: "" };
  const Clock = class extends Date { static now() { return now; } };
  const script = readGoalRelayHtml(filename).match(/<script>([\s\S]*?)<\/script>/)[1];
  runInNewContext(script, { window, document, Date: Clock,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const advance = async (elapsed) => {
    await flush();
    const end = now + elapsed;
    for (let i = 0; i < 1000; i++) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id); now = timer.due; timer.callback(); await flush();
      if (i === 999) throw new Error("unbounded timer loop");
    }
    now = end;
    await flush();
  };
  return { window, document, sent, tools, timers, emit, flush, advance, result,
    setGoal(patch) { currentGoal = { ...currentGoal, ...patch }; }, released: () => released };
}

test("fresh standard-only Apps host initializes and starts Goal without legacy APIs or manual bind", async () => {
  const h = freshHost({ claimMetadata: true });
  await h.advance(1_000);
  assert.equal(h.window.openai, undefined);
  assert.equal(h.sent[0].method, "ui/initialize");
  assert.equal(h.sent[1].method, "ui/notifications/initialized");
  assert.deepEqual(h.tools.map(call => call.name), ["devspace_goal_start", "devspace_goal_status"]);
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.active, true);
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.conversationId, "chat-fresh-host");
  assert.equal(h.tools[0].args.claimId, "claim-fresh-host");
  h.setGoal({ status: "completed" }); await h.advance(10_000);
});

test("fresh Goal bootstrap survives host readiness delayed well beyond three quick attempts", async () => {
  const h = freshHost({ readyAt: 20_000 });
  await h.advance(40_000);
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.active, true);
  assert.equal(h.tools.filter(call => call.name === "devspace_goal_start").length, 1);
  assert.ok(h.sent.filter(message => message.method === "ui/initialize").length > 2);
  h.setGoal({ status: "completed" }); await h.advance(10_000);
});

test("a fresh Goal-result resource also initializes on a standard-only host", async () => {
  const h = freshHost({ filename: "goal-continuation-relay.html" });
  await h.advance(1_000);
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.active, true);
  assert.deepEqual(h.tools.map(call => call.name), ["devspace_goal_status"]);
  h.setGoal({ roundState: "reported", continuation: { state: "pending", continuationId: "fresh-goal-resource-next" } });
  await h.advance(12_000);
  assert.equal(h.tools.filter(call => call.name === "devspace_goal_continuation").length, 1);
  h.setGoal({ status: "completed" }); await h.advance(11_000);
  assert.equal(h.timers.size, 0);
});

test("late legacy API retries the same one-time claim without a new user turn", async () => {
  const h = freshHost({ standard: false });
  await h.advance(2_000);
  assert.equal(h.tools.length, 0);
  h.window.openai.callTool = h.result;
  await h.advance(5_000);
  assert.equal(h.tools.filter(call => call.name === "devspace_goal_start").length, 1);
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.active, true);
  assert.ok(h.tools.some(call => call.name === "devspace_goal_status"));
  h.setGoal({ status: "completed" }); await h.advance(10_000);
});

test("one fresh relay dispatches only the exact backend pending continuation and retires cleanly", async () => {
  const h = freshHost(); await h.advance(1_000);
  h.setGoal({ roundState: "reported", continuation: { state: "pending", continuationId: "continue-fresh-host" } });
  await h.advance(12_000);
  assert.equal(h.tools.filter(call => call.name === "devspace_goal_continuation").length, 1);
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.lastDispatchContinuationId, "continue-fresh-host");
  assert.ok(h.sent.every(message => message.method !== "ui/message"));
  h.setGoal({ status: "completed" }); await h.advance(11_000);
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.active, false);
  assert.equal(h.released(), 1);
  assert.equal(h.timers.size, 0);
});

test("fresh relay never adopts a different conversation as a fallback", async () => {
  const h = freshHost(); await h.advance(1_000);
  h.setGoal({ conversationId: "another-computer-chat", roundState: "reported",
    continuation: { state: "pending", continuationId: "foreign-continuation" } });
  await h.advance(11_000);
  assert.equal(h.tools.filter(call => call.name === "devspace_goal_continuation").length, 0);
  assert.equal(h.window.__DEVSPACE_GOAL_RELAY_STATE__.conversationId, "chat-fresh-host");
  assert.match(h.window.__DEVSPACE_GOAL_RELAY_STATE__.lastError, /exact Goal status unavailable/);
});

test("permanently absent host retires the bounded bootstrap and its retry timers", async () => {
  const h = freshHost({ standard: false });
  await h.advance(100_000);
  assert.equal(h.tools.length, 0);
  assert.equal(h.released(), 1);
  assert.equal(h.timers.size, 0);
});
