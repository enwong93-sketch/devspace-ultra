import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateAcceptance } from './stable-release-acceptance.mjs';

// Deliberately synthetic validator fixtures. These are not release evidence.
function fixture() {
  const sourceCommit = 'a'.repeat(40);
  const archiveSha256 = 'b'.repeat(64);
  const pass = () => ({ result: 'pass', evidenceSha256: 'c'.repeat(64) });
  const evidence = {
    schemaVersion: 1, version: '0.5.19', sourceCommit, archiveSha256,
    client: 'ChatGPT Classic Windows', evidenceKind: 'real-client', ownerReviewed: true,
    observedAt: '2026-10-02T00:00:00Z',
    checks: {
      normalGoal: { ...pass(), observedAssistantTurns: 3, additionalHumanMessages: 0, manualBindCalls: 0, hiddenContinuation: true },
      ordinaryTools: { ...pass(), disposableReadWriteEditCommandReadback: true },
      automaticRescue: { ...pass(), automaticDispatchCount: 1, manualContinueCount: 0, observedAgentWork: true },
      repeatedCoreReplacement: { ...pass(), replacements: 2, duplicateDispatches: 0, statePreserved: true },
      freshInstall: { ...pass(), filesMatchArchive: true, nativeSqliteLoaded: true },
      olderVersionUpgrade: { ...pass(), filesMatchArchive: true, nativeSqliteLoaded: true, statePreserved: true, fromVersion: '0.5.17' },
    },
  };
  const context = { version: '0.5.19', sourceCommit, archiveSha256, now: Date.parse('2026-10-02T01:00:00Z'),
    release: { tag_name: 'v0.5.19', draft: true, assets: [{ name: 'devspace-ultra-0.5.19.tgz', digest: `sha256:${archiveSha256}` }] } };
  return { evidence, context };
}

test('complete matching owner attestation passes the validator, not client acceptance', () => {
  const { evidence, context } = fixture();
  assert.equal(validateAcceptance(evidence, context).ok, true);
});
for (const name of ['normalGoal', 'ordinaryTools', 'automaticRescue', 'repeatedCoreReplacement', 'freshInstall', 'olderVersionUpgrade']) {
  test(`missing or inconclusive ${name} refuses promotion`, () => {
    const { evidence, context } = fixture();
    evidence.checks[name].result = 'inconclusive';
    assert.throws(() => validateAcceptance(evidence, context));
    delete evidence.checks[name];
    assert.throws(() => validateAcceptance(evidence, context));
  });
}
const rejected = [
  ['simulated host evidence', e => { e.evidenceKind = 'vm-host'; }],
  ['wrong product client', e => { e.client = 'Codex'; }],
  ['missing owner review', e => { e.ownerReviewed = false; }],
  ['different source commit', e => { e.sourceCommit = 'd'.repeat(40); }],
  ['different archive', e => { e.archiveSha256 = 'd'.repeat(64); }],
  ['different version', e => { e.version = '0.5.18'; }],
  ['future evidence', e => { e.observedAt = '2030-01-01T00:00:00Z'; }],
  ['manual Goal continuation', e => { e.checks.normalGoal.additionalHumanMessages = 1; }],
  ['manual bind dependency', e => { e.checks.normalGoal.manualBindCalls = 1; }],
  ['unattested visible Goal continuation', e => { e.checks.normalGoal.hiddenContinuation = false; }],
  ['no actual next rounds', e => { e.checks.normalGoal.observedAssistantTurns = 1; }],
  ['manual Rescue', e => { e.checks.automaticRescue.manualContinueCount = 1; }],
  ['duplicate Rescue', e => { e.checks.automaticRescue.automaticDispatchCount = 2; }],
  ['lost Core state', e => { e.checks.repeatedCoreReplacement.statePreserved = false; }],
  ['single Core replacement', e => { e.checks.repeatedCoreReplacement.replacements = 1; }],
  ['wrong installed payload', e => { e.checks.freshInstall.filesMatchArchive = false; }],
  ['no native binding', e => { e.checks.freshInstall.nativeSqliteLoaded = false; }],
  ['same-version upgrade', e => { e.checks.olderVersionUpgrade.fromVersion = '0.5.19'; }],
  ['missing evidence hash', e => { e.checks.normalGoal.evidenceSha256 = '0'.repeat(64); }],
];
for (const [label, mutate] of rejected) {
  test(`${label} refuses promotion`, () => {
    const { evidence, context } = fixture(); mutate(evidence);
    assert.throws(() => validateAcceptance(evidence, context));
  });
}
test('GitHub must confirm the immutable candidate archive digest', () => {
  const { evidence, context } = fixture(); context.release.assets[0].digest = 'sha256:' + 'd'.repeat(64);
  assert.throws(() => validateAcceptance(evidence, context));
});

test('authorized public component messages satisfy the updated no-frontend contract', () => {
  const { evidence, context } = fixture();
  Object.assign(evidence.checks.normalGoal, { hiddenContinuation: false,
    continuationTransport: 'public-component-message', publicMessagesAuthorized: true,
    nativeFinalTriggered: true, foregroundInputUsed: false, focusChanged: false,
    composerMutated: false, automaticScroll: false, duplicateDispatches: 0 });
  assert.equal(validateAcceptance(evidence, context).ok, true);
  for (const key of ['foregroundInputUsed', 'focusChanged', 'composerMutated', 'automaticScroll']) {
    const invalid = structuredClone(evidence); invalid.checks.normalGoal[key] = true;
    assert.throws(() => validateAcceptance(invalid, context), key);
  }
  for (const key of ['publicMessagesAuthorized', 'nativeFinalTriggered']) {
    const invalid = structuredClone(evidence); invalid.checks.normalGoal[key] = false;
    assert.throws(() => validateAcceptance(invalid, context), key);
  }
});
test('already-public or wrong-tag release is refused', () => {
  const { evidence, context } = fixture(); context.release.draft = false;
  assert.throws(() => validateAcceptance(evidence, context));
  context.release.draft = true; context.release.tag_name = 'v0.5.18';
  assert.throws(() => validateAcceptance(evidence, context));
});
test('CLI fails closed without real evidence paths', () => {
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('./stable-release-acceptance.mjs', import.meta.url))], { stdio: 'pipe' }),
    error => error.status === 1 && String(error.stderr).includes('Stable promotion refused: Usage:'));
});
