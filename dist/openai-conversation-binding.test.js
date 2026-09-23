import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openaiConversationIdentity as identity, OpenaiConversationBindings, localBindingAuthorized,
  inspectExactConversationPage, OPENAI_CONVERSATION_PAGE_SOURCE } from './openai-conversation-binding.js';
const request = { auth: { resource: 'https://owned.example/mcp', clientId: 'oauth-client' },
  meta: { 'openai/session': 'opaque-conversation-one', 'openai/subject': 'opaque-user-one', 'openai/organization': 'org-one' } };
const proof = { conversationId: 'conversation-exact-a', runtimeKey: 'main-02', pageVerified: true,
  source: 'classic-exact-page-progress-claim-cdp-page-verified' };

test('official conversation key survives transport reconnect but separates users, organizations and conversations', () => {
  assert.deepEqual(identity({ ...request, headers: { 'mcp-session-id': 'transport-a' } }), identity({ ...request, headers: { 'mcp-session-id': 'transport-b' } }));
  for (const key of ['openai/session', 'openai/subject', 'openai/organization']) {
    assert.notDeepEqual(identity(request), identity({ ...request, meta: { ...request.meta, [key]: 'different' } }));
  }
  assert.notDeepEqual(identity(request), identity({ ...request, auth: { ...request.auth, clientId: 'other-client' } }));
  assert.equal(identity({ ...request, auth: null }), null);
  assert.equal(identity({ ...request, meta: {} }), null);
  assert.equal(identity({ ...request, headers: { 'x-openai-session': 'contradictory' } }), null);
  assert.equal(JSON.stringify(identity(request)).includes('opaque-'), false);
});

test('unbound provider identity never selects a runtime; proved bindings persist without raw metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provider-binding-')); t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'bindings.json');
  let available = true;
  const inspect = async (runtimeKey, conversationId) => available ? { runtimeKey, conversationId, pageVerified: true } : null;
  const registry = new OpenaiConversationBindings({ statePath, inspect });
  const id = identity(request);
  assert.equal(await registry.resolve(id), null);
  assert.equal(await registry.bind(id, { ...proof, pageVerified: false }), null);
  assert.equal(await registry.bind(id, { ...proof, source: 'legacy-session-owner' }), null);
  assert.equal((await registry.bind(id, proof)).bound, true);
  assert.equal((await registry.resolve(id)).conversationId, proof.conversationId);
  available = false; assert.equal(await registry.resolve(id), null);
  available = true;
  const restarted = new OpenaiConversationBindings({ statePath, inspect });
  assert.equal((await restarted.resolve(id)).conversationId, proof.conversationId);
  const persisted = await readFile(statePath, 'utf8');
  assert.equal(persisted.includes('opaque-'), false);
  assert.equal(persisted.includes('oauth-client'), false);
  assert.equal(await restarted.resolve(identity({ ...request, meta: { ...request.meta, 'openai/session': 'other-chat' } })), null);
});

test('conflicting provider-to-URL proof is quarantined, not last-writer-wins', async () => {
  const registry = new OpenaiConversationBindings({ inspect: async (runtimeKey, conversationId) => ({ runtimeKey, conversationId, pageVerified: true }) });
  const id = identity(request);
  await registry.bind(id, proof);
  assert.equal(await registry.bind(id, { ...proof, conversationId: 'conversation-exact-b' }), null);
  assert.equal(await registry.resolve(id), null);
  assert.equal(registry.status().conflicted, 1);
});

test('operator bootstrap requires local owner credential and rejects browser or proxy requests', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-devspace-owner-token': 'owner-secret-value' } };
  assert.equal(localBindingAuthorized(req, 'owner-secret-value'), true);
  assert.equal(localBindingAuthorized(req, 'wrong-secret'), false);
  assert.equal(localBindingAuthorized({ ...req, socket: { remoteAddress: '8.8.8.8' } }, 'owner-secret-value'), false);
  assert.equal(localBindingAuthorized({ ...req, headers: { ...req.headers, origin: 'https://chatgpt.com' } }, 'owner-secret-value'), false);
});

test('exact locator rejects fake hosts, stale routes and duplicate target ambiguity', async () => {
  const fetcher = rows => async () => ({ ok: true, json: async () => rows });
  const good = { type: 'page', id: 'target-a', url: 'https://chatgpt.com/c/conversation-exact-a' };
  assert.equal((await inspectExactConversationPage('main-02', proof.conversationId, fetcher([good]))).source, OPENAI_CONVERSATION_PAGE_SOURCE);
  for (const rows of [[{ ...good, url: 'https://chatgpt.com.evil/c/conversation-exact-a' }], [good, good], [{ ...good, url: 'https://chatgpt.com/c/conversation-exact-b' }]]) {
    assert.equal(await inspectExactConversationPage('main-02', proof.conversationId, fetcher(rows)), null);
  }
});
