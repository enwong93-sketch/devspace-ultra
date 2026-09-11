import assert from "node:assert/strict";
import { ConversationProgressLivenessCdpAdapter } from "../dist/conversation-progress-liveness-cdp.js";

function runtimePort(runtimeKey) {
  const number = Number(String(runtimeKey).slice(-2));
  return number === 1 ? 9721 : 9730 + number;
}

function conversationIdFromUrl(value) {
  try { return new URL(String(value || "")).pathname.match(/\/c\/([^/?#]+)/)?.[1] || null; }
  catch { return null; }
}

async function currentRuntimeConversation(runtimeKey) {
  const port = runtimePort(runtimeKey);
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { cache: "no-store" });
  assert.equal(response.ok, true, `${runtimeKey} DevTools endpoint returned HTTP ${response.status}.`);
  const targets = await response.json();
  const pages = (Array.isArray(targets) ? targets : []).filter((target) => (
    target?.type === "page"
    && /chatgpt\.com/i.test(String(target?.url || ""))
    && conversationIdFromUrl(target.url)
  ));
  assert.equal(pages.length, 1, `${runtimeKey} must expose exactly one ChatGPT conversation page.`);
  return {
    conversationId: conversationIdFromUrl(pages[0].url),
    locatedRuntimeKey: runtimeKey,
    port,
  };
}

const expected = await Promise.all(
  ["main-01", "main-02", "main-03"].map(currentRuntimeConversation),
);
assert.equal(new Set(expected.map((row) => row.conversationId)).size, expected.length,
  "each live Main Runtime must display a different conversation during the isolation gate");

const adapter = new ConversationProgressLivenessCdpAdapter({
  runtimeKeys: ["main-01", "main-02", "main-03"],
});

const results = [];
try {
  for (const row of expected) {
    const result = await adapter.find({ conversationId: row.conversationId });
    assert.equal(result?.exact, true, `${row.conversationId} was not found exactly once.`);
    assert.equal(result?.conversationId, row.conversationId);
    assert.equal(result?.locatedRuntimeKey, row.locatedRuntimeKey);
    assert.equal(result?.port, row.port);
    assert.equal(result?.progressConversationId, row.conversationId,
      "the floating narration card must expose the same conversation id as the page route");
    results.push({
      conversationId: result.conversationId,
      locatedRuntimeKey: result.locatedRuntimeKey,
      port: result.port,
      progressCardMounted: result.progressCardMounted,
      progressConversationId: result.progressConversationId,
    });
  }
  console.log(JSON.stringify({
    ok: true,
    gate: "conversation-progress-runtime03-live",
    authorityKey: "conversationId",
    runtimeBinding: false,
    conversations: results,
  }));
} finally {
  await adapter.close();
}
