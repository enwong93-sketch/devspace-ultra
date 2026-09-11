import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCapabilityTools } from './capability-runtime.js';

function harness(resolveConversation) {
  const handlers = new Map(), calls = [];
  const server = { registerTool(name, _meta, handler) { handlers.set(name, handler); return { update() {} }; } };
  const runtime = {
    async ensureConversationInstance(input) { calls.push({ kind: 'instance', input }); return { instanceToken: 'instance-token-for-unit-test' }; },
    async call(input, options) { calls.push({ kind: 'call', input, options }); return { ok: true }; },
  };
  registerCapabilityTools(server, runtime, { resolveConversation });
  return { call: handlers.get('capability_call'), calls };
}
test('declared command adapter does not enter ambient MCP identity wait', async () => {
  let resolutions = 0;
  const h = harness(() => { resolutions++; throw new Error('Must not resolve a Runtime for a stateless command.'); });
  await h.call({ pluginId: 'unit-only', kind: 'tool', toolName: 'scoped-command', arguments: {} }, {});
  assert.equal(resolutions, 0); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].input.kind, 'tool'); assert.equal(h.calls[0].options.ownerConversationId, null);
});
test('MCP still resolves exact conversation and uses isolated transport', async () => {
  const h = harness(async () => ({ conversationId: 'unit-conversation-1234' }));
  await h.call({ pluginId: 'unit-only', kind: 'mcp', serverId: 'unit-server', toolName: 'read', arguments: {} }, {});
  assert.equal(h.calls[0].kind, 'instance');
  assert.equal(h.calls[0].input.ownerConversationId, 'unit-conversation-1234');
  assert.equal(h.calls[1].options.ownerConversationId, 'unit-conversation-1234');
});
test('command adapter cannot smuggle another Runtime or MCP instance', async () => {
  const h = harness(async () => ({ conversationId: 'unit-conversation-1234' }));
  await h.call({ pluginId: 'unit-only', kind: 'tool', toolName: 'read', runtimeId: 'foreign-runtime', arguments: {} }, {});
  assert.equal(h.calls.length, 0);
});
