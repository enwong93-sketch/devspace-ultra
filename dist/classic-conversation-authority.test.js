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
assert.equal(sessionFingerprintFromMcpExtra({ requestInfo: { headers: { "oai-session-id": rawSession } } }), fp);
assert.equal(sessionFingerprintFromMcpExtra({ sessionId: "generic-mcp-session" }), null, "generic MCP session id must never substitute for OpenAI session evidence");
assert.equal(sessionFingerprintFromClassicRequest({ headers: { "X-OpenAI-Session": rawSession } }), fp);
assert.equal(sessionFingerprintFromClassicRequest({ headers: { "OAI-Session-ID": rawSession } }), fp, "native ChatGPT call_mcp requests expose oai-session-id rather than x-openai-session");

const root = await mkdtemp(join(tmpdir(), "classic-conversation-authority-test-"));
const statePath = join(root, "authority.json");
try {
  const registry = new ClassicConversationAuthorityRegistry({ statePath });
  await registry.load();
  assert.equal(registry.resolveMcpExtra({ _meta: { "openai/session": rawSession } }), null, "unobserved session must fail closed");

  const cancelledFingerprint = "c".repeat(64);
  const cancellation = new AbortController();
  const cancelledWait = registry.waitForFingerprint(cancelledFingerprint, { signal: cancellation.signal });
  cancellation.abort();
  await assert.rejects(cancelledWait, /cancelled/i, "an abandoned MCP request must remove only its request-scoped authority waiter");
  assert.equal(registry.waiters.size, 0, "cancelled authority waiters must not survive as zombie promises");
  await registry.observeNativeTurn({
    sessionFingerprint: cancelledFingerprint,
    conversationId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    runtimeKey: "Main-03",
    observedAt: "2026-09-06T03:49:00.000Z",
  });
  assert.equal(registry.waiters.size, 0);

  const waiterA = registry.waitForFingerprint(fp);
  const waiterB = registry.waitForFingerprint(fp);
  assert.equal(registry.waiters.size, 2, "each pending tool request must own an independently cancellable authority waiter");

  await registry.observeNativeTurn({
    sessionFingerprint: fp,
    conversationId: "6a9c696c-9630-83e8-a70f-4bbe4b59e5d1",
    runtimeKey: "Main-02",
    observedAt: "2026-09-06T03:50:00.000Z",
  });
  assert.equal((await waiterA)?.conversationId, "6a9c696c-9630-83e8-a70f-4bbe4b59e5d1");
  assert.equal((await waiterB)?.conversationId, "6a9c696c-9630-83e8-a70f-4bbe4b59e5d1");
  assert.equal(registry.waiters.size, 0);
  assert.equal(registry.resolveMcpExtra({ _meta: { "openai/session": rawSession } })?.conversationId, "6a9c696c-9630-83e8-a70f-4bbe4b59e5d1");
  assert.equal(registry.snapshot().sessions[0].ambiguous, false);

  const freshWait = registry.waitForFingerprint(fp, {
    minimumObservedAt: "2026-09-06T03:50:30.000Z",
  });
  let freshSettled = false;
  freshWait.then(() => { freshSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(freshSettled, false, "an old session mapping must not satisfy a request waiting for current-turn evidence");
  await registry.observeNativeTurn({
    sessionFingerprint: fp,
    conversationId: "6a9c696c-9630-83e8-a70f-4bbe4b59e5d1",
    runtimeKey: "Main-02",
    observedAt: "2026-09-06T03:50:31.000Z",
  });
  assert.equal((await freshWait)?.conversationId, "6a9c696c-9630-83e8-a70f-4bbe4b59e5d1");

  const timeoutRegistry = new ClassicConversationAuthorityRegistry({
    statePath: join(root, "timeout-authority.json"),
    waitTimeoutMs: 100,
  });
  await timeoutRegistry.load();
  const timeoutStartedAt = Date.now();
  assert.equal(await timeoutRegistry.waitForFingerprint("d".repeat(64)), null);
  assert.equal(Date.now() - timeoutStartedAt < 1_500, true, "missing authority must fail closed promptly");
  assert.equal(timeoutRegistry.waiters.size, 0);
  assert.equal(timeoutRegistry.diagnostics().timedOutWaiters, 1);

  const persistedText = await readFile(statePath, "utf8");
  assert.doesNotMatch(persistedText, /opaque-openai-session-value/, "raw OpenAI session value must never be persisted");
  assert.match(persistedText, new RegExp(fp));

  const restored = new ClassicConversationAuthorityRegistry({ statePath });
  await restored.load();
  assert.equal(restored.resolveFingerprint(fp)?.conversationId, "6a9c696c-9630-83e8-a70f-4bbe4b59e5d1");

  await restored.observeNativeTurn({
    sessionFingerprint: fp,
    conversationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    runtimeKey: "Main-02",
    observedAt: "2026-09-06T03:50:30.000Z",
    authoritativeCurrent: true,
  });
  assert.equal(restored.resolveFingerprint(fp)?.conversationId, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "the exact native call_mcp request must move a reused runtime session to its current conversation instead of creating a permanent ambiguity");

  await restored.observeNativeTurn({
    sessionFingerprint: fp,
    conversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    runtimeKey: "Main-02",
    observedAt: "2026-09-06T03:51:00.000Z",
  });
  assert.equal(restored.resolveFingerprint(fp), null, "same session observed with two conversations must become ambiguous and fail closed");
  const ambiguous = restored.snapshot().sessions[0];
  assert.equal(ambiguous.ambiguous, true);
  assert.deepEqual(ambiguous.conversationIds.sort(), ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"].sort());

  const verified = await restored.acceptVerifiedRollover({
    oldConversationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    newConversationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    runtimeKey: "Main-02",
    observedAt: "2026-09-06T03:52:00.000Z",
  });
  assert.equal(verified.updatedSessions, 1);
  assert.equal(restored.resolveFingerprint(fp)?.conversationId, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  const migrated = restored.snapshot().sessions[0];
  assert.equal(migrated.ambiguous, false);
  assert.equal(migrated.continuity.at(-1).from, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  assert.equal(migrated.continuity.at(-1).to, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  await assert.rejects(
    () => restored.acceptVerifiedRollover({ oldConversationId: "missing-source", newConversationId: "new-target", runtimeKey: "Main-02" }),
    /No Classic MCP session authority/i,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, gate: "classic-conversation-authority", nativeOnly: true, ambiguityFailsClosed: true }));
