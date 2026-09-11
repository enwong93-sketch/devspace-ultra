import assert from "node:assert/strict";
import { ConversationProgressLivenessCdpAdapter } from "../dist/conversation-progress-liveness-cdp.js";

const expected = [
  { conversationId: "6a9db09c-ee60-83e8-92b4-bcd20182c8a9", locatedRuntimeKey: "main-01", port: 9721 },
  { conversationId: "6a9ee306-b74c-83ee-a67c-3d11d1c065d3", locatedRuntimeKey: "main-02", port: 9732 },
  { conversationId: "6aa39a50-ce74-83ee-9a44-2c9a1a44db6a", locatedRuntimeKey: "main-03", port: 9733 },
];

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
