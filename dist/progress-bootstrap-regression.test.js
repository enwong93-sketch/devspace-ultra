import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgressBootstrapAuthorityRegistry } from './progress-bootstrap-authority.js';

const at = Date.parse('2026-09-20T08:00:00Z');
const sessionFingerprint = 'a'.repeat(64);
const trace = 'b'.repeat(64);
const proof = {
  sessionFingerprint,
  traceCorrelationFingerprints: [trace],
  claimId: 'claim_exact_progress_20260920',
  conversationId: 'conversation-bootstrap-a',
  runtimeKey: 'main-01',
  observedAt: new Date(at).toISOString(),
  source: 'classic-exact-page-progress-claim-cdp-page-verified',
  pageVerified: true,
};
const request = {
  sessionFingerprint,
  traceCorrelationFingerprints: [trace],
  toolName: 'devspace_goal_start',
  verifyPage: async () => proof,
};

test('another request sharing the host session cannot inherit conversation A', async () => {
  const registry = new ProgressBootstrapAuthorityRegistry({ now: () => at });
  registry.register(proof);
  assert.equal(await registry.consume({ ...request, traceCorrelationFingerprints: ['c'.repeat(64)] }), null);
  assert.equal(await registry.consumeCapability({
    ...request,
    toolName: 'exec_command',
    traceCorrelationFingerprints: ['c'.repeat(64)],
  }), null);
});

test('same-turn capability lease is repeatable and still revalidates the exact page', async () => {
  const registry = new ProgressBootstrapAuthorityRegistry({ now: () => at });
  registry.register(proof);
  const input = { ...request, toolName: 'read' };
  assert.equal((await registry.consumeCapability(input))?.conversationId, proof.conversationId);
  assert.equal((await registry.consumeCapability(input))?.conversationId, proof.conversationId);
  assert.equal(await registry.consumeCapability({ ...input, verifyPage: async () => null }), null);
});

test('missing or disappeared current page proof cannot authorize a start', async () => {
  const registry = new ProgressBootstrapAuthorityRegistry({ now: () => at });
  registry.register(proof);
  assert.equal(await registry.consume({ ...request, verifyPage: undefined }), null);
  assert.equal(await registry.consume({ ...request, verifyPage: async () => null }), null);
  assert.equal(await registry.consume({ ...request, verifyPage: async () => ({ ...proof, conversationId: 'conversation-bootstrap-b' }) }), null);
  assert.equal((await registry.consume(request))?.conversationId, proof.conversationId);
});

test('stale and unverified progress evidence is never refreshed into authority', () => {
  const registry = new ProgressBootstrapAuthorityRegistry({ now: () => at + 700_000 });
  assert.equal(registry.register(proof), null);
  assert.equal(registry.register({ ...proof, observedAt: new Date(at + 700_000).toISOString(), pageVerified: false }), null);
});

test('asynchronous page verification has a single consumption commit point', async () => {
  const registry = new ProgressBootstrapAuthorityRegistry({ now: () => at });
  registry.register(proof);
  const result = await Promise.all([registry.consume(request), registry.consume(request)]);
  assert.equal(result.filter(Boolean).length, 1);
  registry.register(proof);
  assert.equal(await registry.consume(request), null, 'replaying the same claim must not replenish a grant');
});

test('a lease expiring during page verification cannot commit', async () => {
  let now = at;
  const registry = new ProgressBootstrapAuthorityRegistry({ now: () => now, ttlMs: 5_000 });
  registry.register(proof);
  assert.equal(await registry.consume({ ...request, verifyPage: async () => { now += 5_001; return proof; } }), null);
});
