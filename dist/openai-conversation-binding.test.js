import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openaiConversationIdentity as identity, OpenaiConversationBindings, localBindingAuthorized,
  inspectExactConversationPage, OPENAI_CONVERSATION_PAGE_SOURCE, verifiedLocalProviderBinding } from './openai-conversation-binding.js';
const request = { auth: { resource: 'https://owned.example/mcp', clientId: 'oauth-client' },
  meta: { 'openai/session': 'opaque-conversation-one', 'openai/subject': 'opaque-user-one', 'openai/organization': 'org-one' } };
const proof = { conversationId: 'conversation-exact-a', runtimeKey: 'main-02', pageVerified: true,
  source: 'classic-exact-page-progress-claim-cdp-page-verified' };
const serverInstanceA = 'dsi_instance_a_20260928';
const serverInstanceB = 'dsi_instance_b_20260928';

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
  const registry = new OpenaiConversationBindings({ statePath, inspect, serverInstanceId: serverInstanceA });
  const id = identity(request);
  assert.equal(await registry.resolve(id), null);
  assert.equal(await registry.bind(id, { ...proof, pageVerified: false }), null);
  assert.equal(await registry.bind(id, { ...proof, source: 'legacy-session-owner' }), null);
  assert.equal((await registry.bind(id, proof)).bound, true);
  assert.equal((await registry.resolve(id)).conversationId, proof.conversationId);
  const verified = await registry.resolve(id);
  assert.equal(verifiedLocalProviderBinding(verified, id), true);
  assert.equal(verifiedLocalProviderBinding(verified, identity({ ...request,
    auth: { ...request.auth, resource: 'https://other-computer.example/mcp' } })), false,
    'another computer resource cannot borrow this bound page');
  assert.equal(verifiedLocalProviderBinding({ ...verified, pageVerified: false }, id), false);
  assert.equal(verifiedLocalProviderBinding({ ...verified, source: 'legacy-session-owner' }, id), false);
  assert.equal(verifiedLocalProviderBinding({ ...verified, runtimeKey: 'main-99' }, id), false);
  available = false; assert.equal(await registry.resolve(id), null);
  available = true;
  const restarted = new OpenaiConversationBindings({ statePath, inspect, serverInstanceId: serverInstanceA });
  assert.equal((await restarted.resolve(id)).conversationId, proof.conversationId);
  const persisted = await readFile(statePath, 'utf8');
  assert.equal(JSON.parse(persisted).version, 2);
  assert.equal(JSON.parse(persisted).serverInstanceId, serverInstanceA);
  assert.equal(persisted.includes('opaque-'), false);
  assert.equal(persisted.includes('oauth-client'), false);
  assert.equal(await restarted.resolve(identity({ ...request, meta: { ...request.meta, 'openai/session': 'other-chat' } })), null);
});

test('a late exact invocation binds a rotated provider alias for the same physical conversation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provider-alias-binding-')); t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'bindings.json');
  const inspect = async (runtimeKey, conversationId) => ({ runtimeKey, conversationId, pageVerified: true });
  const registry = new OpenaiConversationBindings({ statePath, inspect, serverInstanceId: serverInstanceA });
  const original = identity(request);
  const rotatedRequest = {
    ...request,
    meta: { ...request.meta, 'openai/session': 'opaque-conversation-rotated-alias' },
  };
  const rotated = identity(rotatedRequest);
  await registry.bind(original, proof);
  assert.equal(await registry.resolve(rotated), null, 'an unseen provider alias is not trusted before exact correlation');
  const exactInvocation = {
    ...proof,
    source: 'classic-native-call-mcp-page-verified',
    currentInvocationVerified: true,
    callFingerprint: 'c'.repeat(64),
  };
  assert.equal(await registry.bind(rotated, exactInvocation), null,
    'current invocation proof must be explicitly selected by the internal caller');
  assert.equal((await registry.bind(rotated, exactInvocation, { currentInvocation: true }))?.bound, true);
  assert.equal((await registry.resolve(rotated))?.conversationId, proof.conversationId);
  assert.equal(registry.status().bindings, 2, 'both host aliases resolve to the same exact physical conversation');
  assert.equal(await registry.resolve(identity({
    ...rotatedRequest,
    auth: { ...request.auth, resource: 'https://another-computer.example/mcp' },
  })), null, 'another server resource cannot borrow this provider alias binding');
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(persisted.bindings.some((row) => row.provenance === 'authenticated-current-invocation-exact-page'), true);
});

test('conflicting provider-to-URL proof is quarantined, not last-writer-wins', async () => {
  const registry = new OpenaiConversationBindings({
    inspect: async (runtimeKey, conversationId) => ({ runtimeKey, conversationId, pageVerified: true }),
    serverInstanceId: serverInstanceA,
  });
  const id = identity(request);
  await registry.bind(id, proof);
  assert.equal(await registry.bind(id, { ...proof, conversationId: 'conversation-exact-b' }), null);
  assert.equal(await registry.resolve(id), null);
  assert.equal(registry.status().conflicted, 1);
});

test('persisted provider bindings reset on server-instance mismatch and legacy unscoped state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provider-instance-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inspect = async (runtimeKey, conversationId) => ({ runtimeKey, conversationId, pageVerified: true });
  const id = identity(request);
  const statePath = join(root, 'bindings.json');
  const first = new OpenaiConversationBindings({ statePath, inspect, serverInstanceId: serverInstanceA });
  assert.equal((await first.bind(id, proof))?.bound, true);
  const changedInstance = new OpenaiConversationBindings({ statePath, inspect, serverInstanceId: serverInstanceB });
  assert.equal(await changedInstance.resolve(id), null,
    'a logical server instance cannot reuse the previous instance binding store');
  assert.equal(changedInstance.status().resetReason, 'server-instance-mismatch');
  assert.equal((await changedInstance.bind(id, proof))?.bound, true,
    'the current exact page may establish a fresh binding after the safe reset');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).serverInstanceId, serverInstanceB);

  const legacyPath = join(root, 'legacy-bindings.json');
  await writeFile(legacyPath, JSON.stringify({
    version: 1,
    bindings: [{
      key: id.key,
      conversationId: proof.conversationId,
      runtimes: [proof.runtimeKey],
      boundAt: new Date().toISOString(),
      conflicted: false,
    }],
  }));
  const migrated = new OpenaiConversationBindings({
    statePath: legacyPath,
    inspect,
    serverInstanceId: serverInstanceA,
  });
  assert.equal(await migrated.resolve(id), null,
    'an unscoped legacy binding requires one new exact-page bootstrap');
  assert.equal(migrated.status().resetReason, 'legacy-store-without-server-instance');
  assert.equal((await migrated.bind(id, proof))?.bound, true);
  const migratedState = JSON.parse(await readFile(legacyPath, 'utf8'));
  assert.equal(migratedState.version, 2);
  assert.equal(migratedState.serverInstanceId, serverInstanceA);
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
