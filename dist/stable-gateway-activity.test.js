import assert from "node:assert/strict";
import { createStableGatewayActivityJournal, summarizeStableGatewayToolCall } from "./stable-gateway-activity.js";

const summary = summarizeStableGatewayToolCall("bash", {
  command: "curl -H 'Authorization: Bearer secret-token-value' https://example.test && echo PASSWORD=hunter2",
  workingDirectory: "dist",
});
assert.match(summary, /bash/i);
assert.match(summary, /dist/i);
assert.doesNotMatch(summary, /secret-token-value|hunter2/i, "activity summaries must never retain obvious credential values");
assert.match(summary, /REDACTED/, "redaction should be visible rather than silently dropping the whole command");

const journal = createStableGatewayActivityJournal({ limit: 3, now: (() => { let t = 1000; return () => t += 10; })() });
const first = journal.startToolCall({ toolName: "read", arguments: { path: "dist/server.js", offset: 1, limit: 20 } });
assert.equal(first.state, "running");
assert.equal(journal.snapshot().activities.length, 1);
journal.finishToolCall(first.id, { ok: true, statusCode: 200 });
assert.equal(journal.snapshot().activities[0].state, "completed");
assert.equal(journal.snapshot().activities[0].statusCode, 200);
assert.ok(journal.snapshot().activities[0].durationMs >= 0);

journal.noteSystem({ title: "Core recovered", detail: "Core A restarted" });
journal.noteSystem({ title: "Another", detail: "event" });
journal.noteSystem({ title: "Newest", detail: "event" });
const snapshot = journal.snapshot();
assert.equal(snapshot.activities.length, 3, "journal must stay bounded");
assert.equal(snapshot.activities[0].title, "Newest");

console.log(JSON.stringify({ ok: true, gate: "stable-gateway-activity", redaction: true, bounded: true }));
