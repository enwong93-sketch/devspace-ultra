import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClassicConversationAuthorityRegistry,
  fingerprintClassicSession,
  sessionFingerprintFromMcpExtra,
  sessionFingerprintFromClassicRequest,
} from "./classic-conversation-authority.js";

const rawSession = "opaque-openai-session-value";
const fp = fingerprintClassicSession(rawSession);
assert.match(fp, /^[a-f0-9]{64}$/);
assert.equal(sessionFingerprintFromMcpExtra({ _meta: { "openai/session": rawSession } }), fp);
assert.equal(sessionFingerprintFromMcpExtra({ requestInfo: { headers: { "x-openai-session": rawSession } } }), fp);
assert.equal(sessionFingerprintFromMcpExtra({ sessionId: "generic-mcp-session" }), null, "generic MCP session id must never substitute for OpenAI session evidence");
assert.equal(sessionFingerprintFromClassicRequest({ headers: { "X-OpenAI-Session": rawSession } }), fp);

const root = await mkdtemp(join(tmpdir(), "classic-conversation-authority-test-"));
const statePath = join(root, "authority.json");
try {
  const registry = new ClassicConversationAuthorityRegistry({ statePath });
  await registry.load();
  assert.equal(registry.resolveMcpExtra({ _meta: { "openai/session": rawSession } }), null, "unobserved session must fail closed");

  await registry.observeNativeTurn({
    sessionFingerprint: fp,
    conversationId: "6a9c696c-9630-83e8-a70f-4bbe4b59e5d1",
    runtimeKey: "Main-02",
    observedAt: "2026-09-06T03:50:00.000Z",
  });
  assert.equal(registry.resolveMcpExtra({ _meta: { "openai/session": rawSession } })?.conversationId, "6a9c696c-9630-83e8-a70f-4bbe4b59e5d1");
  assert.equal(registry.snapshot().sessions[0].ambiguous, false);

  const persistedText = await readFile(statePath, "utf8");
  assert.doesNotMatch(persistedText, /opaque-openai-session-value/, "raw OpenAI session value must never be persisted");
  assert.match(persistedText, new RegExp(fp));

  const restored = new ClassicConversationAuthorityRegistry({ statePath });
  await restored.load();
  assert.equal(restored.resolveFingerprint(fp)?.conversationId, "6a9c696c-9630-83e8-a70f-4bbe4b59e5d1");

  await restored.observeNativeTurn({
    sessionFingerprint: fp,
    conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    runtimeKey: "Main-02",
    observedAt: "2026-09-06T03:51:00.000Z",
  });
  assert.equal(restored.resolveFingerprint(fp), null, "same session observed with two conversations must become ambiguous and fail closed");
  const ambiguous = restored.snapshot().sessions[0];
  assert.equal(ambiguous.ambiguous, true);
  assert.deepEqual(ambiguous.conversationIds.sort(), ["6a9c696c-9630-83e8-a70f-4bbe4b59e5d1", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"].sort());

  const verified = await restored.acceptVerifiedRollover({
    oldConversationId: "6a9c696c-9630-83e8-a70f-4bbe4b59e5d1",
    newConversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    runtimeKey: "Main-02",
    observedAt: "2026-09-06T03:52:00.000Z",
  });
  assert.equal(verified.updatedSessions, 1);
  assert.equal(restored.resolveFingerprint(fp)?.conversationId, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  const migrated = restored.snapshot().sessions[0];
  assert.equal(migrated.ambiguous, false);
  assert.equal(migrated.continuity.at(-1).from, "6a9c696c-9630-83e8-a70f-4bbe4b59e5d1");
  assert.equal(migrated.continuity.at(-1).to, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await assert.rejects(
    () => restored.acceptVerifiedRollover({ oldConversationId: "missing-source", newConversationId: "new-target", runtimeKey: "Main-02" }),
    /No Classic MCP session authority/i,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, gate: "classic-conversation-authority", nativeOnly: true, ambiguityFailsClosed: true }));
