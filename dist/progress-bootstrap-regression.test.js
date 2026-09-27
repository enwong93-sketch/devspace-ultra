import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProgressBootstrapAuthorityRegistry,
  PROGRESS_CAPABILITY_PAGE_SOURCE,
  resolveRequestCapabilityAuthority,
} from './progress-bootstrap-authority.js';

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

test('active exact conversation work survives relay cleanup and renews beyond the original fixed expiry', async () => {
  let now = at;
  const registry = new ProgressBootstrapAuthorityRegistry({ now: () => now, ttlMs: 5_000 });
  registry.register(proof);
  const callFingerprint = '3'.repeat(64);
  const verifyConversationPage = async ({ conversationId, runtimeKey }) => ({
    conversationId,
    runtimeKey,
    exact: true,
    ambiguous: false,
    duplicatePageObserved: false,
    hydrated: true,
    composerFound: true,
    pageVerified: true,
    observedAt: new Date(now).toISOString(),
    source: PROGRESS_CAPABILITY_PAGE_SOURCE,
  });
  const input = {
    ...request,
    toolName: 'read',
    callFingerprint,
    verifyPage: async () => null,
    verifyConversationPage,
  };
  now += 4_000;
  const first = await registry.consumeCapability(input);
  assert.equal(first?.conversationId, proof.conversationId);
  assert.equal(first?.claimRelayVerified, false,
    'the bounded hidden relay is not required after the exact conversation page is reverified');
  assert.equal(first?.callFingerprint, callFingerprint,
    'the current request fingerprint remains available for provider-alias binding');
  now += 4_000;
  assert.equal((await registry.consumeCapability(input))?.conversationId, proof.conversationId);
  now += 4_000;
  assert.equal((await registry.consumeCapability(input))?.conversationId, proof.conversationId,
    'verified active work remains authorized well beyond the original five-second lease');
  const diagnostics = registry.diagnostics();
  assert.equal(diagnostics.activeSessions, 1);
  assert.equal(diagnostics.ownerCount, 1);
  assert.equal(diagnostics.sharedSessionCount, 0);
  assert.equal(diagnostics.capabilityConversationPageVerified, 3,
    'relay-free exact-page calls are visible in secret-free diagnostics');
  assert.equal(diagnostics.capabilityClaimRelayVerified, 0);
  assert.equal(diagnostics.nearestExpiryMs, 5_000);
  assert.equal(diagnostics.farthestExpiryMs, 5_000);
  assert.equal(diagnostics.oldestUpdatedAgeMs, 0);
});

test('direct conversation-page keepalive rejects duplicate, stale, wrong-runtime and unhydrated proof', async () => {
  const variants = [
    { duplicatePageObserved: true },
    { ambiguous: true },
    { runtimeKey: 'main-02' },
    { hydrated: false },
    { composerFound: false },
    { exact: false },
    { source: 'untrusted-page-proof' },
  ];
  for (const variant of variants) {
    const registry = new ProgressBootstrapAuthorityRegistry({ now: () => at });
    registry.register(proof);
    const direct = {
      conversationId: proof.conversationId,
      runtimeKey: proof.runtimeKey,
      exact: true,
      ambiguous: false,
      duplicatePageObserved: false,
      hydrated: true,
      composerFound: true,
      pageVerified: true,
      observedAt: new Date(at).toISOString(),
      source: PROGRESS_CAPABILITY_PAGE_SOURCE,
      ...variant,
    };
    assert.equal(await registry.consumeCapability({
      ...request,
      toolName: 'read',
      verifyPage: async () => null,
      verifyConversationPage: async () => direct,
    }), null, `unsafe direct page variant must fail closed: ${JSON.stringify(variant)}`);
  }
});

test('fresh exact work keeps a claim lease alive across rotated host-session aliases', async () => {
  let now = at;
  const registry = new ProgressBootstrapAuthorityRegistry({ now: () => now, ttlMs: 5_000 });
  registry.register(proof);
  assert.equal((await registry.consume(request))?.conversationId, proof.conversationId);
  now += 4_000;
  const rotatedSession = 'd'.repeat(64);
  const rotatedTrace = 'e'.repeat(64);
  const refreshed = registry.refreshCapabilityLease({
    sessionFingerprint: rotatedSession,
    conversationId: proof.conversationId,
    runtimeKey: proof.runtimeKey,
    traceCorrelationFingerprints: [rotatedTrace],
    pageVerified: true,
    exactInvocationVerified: true,
    source: 'classic-native-call-mcp-page-verified',
  });
  assert.equal(refreshed?.ok, true);
  assert.equal(refreshed?.aliasSessionAdded, true);
  now += 4_000;
  const rotatedRequest = {
    sessionFingerprint: rotatedSession,
    traceCorrelationFingerprints: [rotatedTrace],
    verifyPage: async () => ({ ...proof, observedAt: new Date(now).toISOString() }),
  };
  assert.equal((await registry.consumeCapability({ ...rotatedRequest, toolName: 'read' }))?.conversationId,
    proof.conversationId, 'the alias lease remains active beyond the original fixed expiry');
  assert.equal(await registry.consume({ ...rotatedRequest, toolName: 'devspace_goal_start' }), null,
    'alias keepalive shares the one-shot Goal grant instead of replenishing it');
  assert.equal(registry.diagnostics().capabilityRefreshed, 1);
});

test('a reusable host session selects the trace-matched conversation and rejects trace collisions', async () => {
  const registry = new ProgressBootstrapAuthorityRegistry({ now: () => at });
  registry.register(proof);
  const reusedSession = 'f'.repeat(64);
  const otherTrace = '1'.repeat(64);
  const otherProof = {
    ...proof,
    sessionFingerprint: reusedSession,
    traceCorrelationFingerprints: [otherTrace],
    claimId: 'claim_other_conversation_20260928',
    conversationId: 'conversation-bootstrap-b',
    runtimeKey: 'main-02',
  };
  registry.register({
    ...otherProof,
  });
  const refreshed = registry.refreshCapabilityLease({
    sessionFingerprint: reusedSession,
    conversationId: proof.conversationId,
    runtimeKey: proof.runtimeKey,
    traceCorrelationFingerprints: [trace],
    pageVerified: true,
    exactInvocationVerified: true,
    source: 'classic-native-call-mcp-page-verified',
  });
  assert.equal(refreshed?.ok, true);
  assert.equal(refreshed?.sharedHostSession, true,
    'a reusable transport may retain independent exact conversation owners');
  assert.equal((await registry.consumeCapability({
    sessionFingerprint: reusedSession,
    traceCorrelationFingerprints: [trace],
    toolName: 'read',
    verifyPage: async () => proof,
  }))?.conversationId, proof.conversationId,
  'the exact trace selects conversation A instead of rejecting the whole transport');
  assert.equal((await registry.consumeCapability({
    sessionFingerprint: reusedSession,
    traceCorrelationFingerprints: [otherTrace],
    toolName: 'read',
    verifyPage: async () => otherProof,
  }))?.conversationId, otherProof.conversationId,
  'the other exact trace independently selects conversation B');
  assert.equal(registry.refreshCapabilityLease({
    sessionFingerprint: reusedSession,
    conversationId: proof.conversationId,
    runtimeKey: proof.runtimeKey,
    traceCorrelationFingerprints: [otherTrace],
    pageVerified: true,
    exactInvocationVerified: true,
    source: 'classic-native-call-mcp-page-verified',
  }), null, 'one trace cannot be reassigned across two exact conversations');
  assert.equal(registry.diagnostics().ambiguousSessions, 0,
    'distinct trace owners are shared transport state, not ambiguous identity');
  assert.equal(registry.diagnostics().sharedSessionCount, 1);
});

test('Goal and Plan bootstrap select one trace-matched owner on a reusable host session', async () => {
  const registry = new ProgressBootstrapAuthorityRegistry({ now: () => at });
  const sharedSession = '9'.repeat(64);
  const traceA = 'a'.repeat(64);
  const traceB = 'b'.repeat(64);
  const proofA = { ...proof, sessionFingerprint: sharedSession, traceCorrelationFingerprints: [traceA] };
  const proofB = {
    ...proof,
    sessionFingerprint: sharedSession,
    traceCorrelationFingerprints: [traceB],
    claimId: 'claim_trace_selected_owner_b_20260928',
    conversationId: 'conversation-bootstrap-b',
    runtimeKey: 'main-02',
  };
  registry.register(proofA);
  registry.register(proofB);
  assert.equal((await registry.consume({
    sessionFingerprint: sharedSession,
    traceCorrelationFingerprints: [traceA],
    toolName: 'devspace_plan_start',
    verifyPage: async () => proofA,
  }))?.conversationId, proofA.conversationId);
  assert.equal((await registry.consume({
    sessionFingerprint: sharedSession,
    traceCorrelationFingerprints: [traceB],
    toolName: 'devspace_plan_start',
    verifyPage: async () => proofB,
  }))?.conversationId, proofB.conversationId);
  assert.equal(await registry.consume({
    sessionFingerprint: sharedSession,
    traceCorrelationFingerprints: [traceA, traceB],
    toolName: 'devspace_goal_start',
    verifyPage: async () => proofA,
  }), null, 'a request trace matching multiple owners remains fail-closed');
});

test('the instance gate waits for bounded late exact correlation before asking for another claim', async () => {
  let settle;
  const lateAuthority = new Promise((resolve) => { settle = resolve; });
  const expected = {
    conversationId: proof.conversationId,
    runtimeKey: proof.runtimeKey,
    source: 'classic-native-call-mcp-page-verified',
    pageVerified: true,
    currentInvocationVerified: true,
    callFingerprint: '2'.repeat(64),
  };
  const resolving = resolveRequestCapabilityAuthority({
    requestConversation: { capabilityAuthority: null, authorityPromise: lateAuthority },
    requestedToolName: 'exec_command',
    sessionFingerprint,
    traceCorrelationFingerprints: [trace],
    progressBootstrapAuthority: { consumeCapability: async () => null },
    verifyPage: async () => null,
    allowLateCorrelation: true,
    lateCorrelationTimeoutMs: 500,
  });
  settle(expected);
  assert.deepEqual(await resolving, expected,
    'a late native exact-page match is admitted instead of returning devspace_instance_binding_required');
});

test('late correlation waiting is bounded and can be skipped for requests without provider identity', async () => {
  const never = new Promise(() => {});
  const startedAt = Date.now();
  assert.equal(await resolveRequestCapabilityAuthority({
    requestConversation: { authorityPromise: never },
    requestedToolName: 'read',
    sessionFingerprint,
    traceCorrelationFingerprints: [trace],
    progressBootstrapAuthority: { consumeCapability: async () => null },
    verifyPage: async () => null,
    allowLateCorrelation: true,
    lateCorrelationTimeoutMs: 100,
  }), null);
  assert.equal(Date.now() - startedAt < 1_000, true, 'late correlation cannot hang the instance gate');
  const skippedAt = Date.now();
  assert.equal(await resolveRequestCapabilityAuthority({
    requestConversation: { authorityPromise: never },
    requestedToolName: 'read',
    sessionFingerprint,
    traceCorrelationFingerprints: [trace],
    progressBootstrapAuthority: { consumeCapability: async () => null },
    verifyPage: async () => null,
    allowLateCorrelation: false,
  }), null);
  assert.equal(Date.now() - skippedAt < 100, true, 'requests without provider identity do not wait on page correlation');
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
