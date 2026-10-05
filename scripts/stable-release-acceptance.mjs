import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hashPattern = /^[a-f0-9]{64}$/;
const checkNames = [
  'normalGoal', 'ordinaryTools', 'automaticRescue', 'repeatedCoreReplacement',
  'freshInstall', 'olderVersionUpgrade',
];

function requireHash(value, label) {
  assert.match(value ?? '', hashPattern, `${label} must be a SHA-256`);
  assert.notEqual(value, '0'.repeat(64), `${label} must not be a placeholder`);
}

// This validates an owner's attestation, not the real client itself. Unit-test
// fixtures and local health never manufacture a real-client acceptance record.
export function validateAcceptance(evidence, { version, sourceCommit, archiveSha256, release, now = Date.now() }) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  requireHash(archiveSha256, 'archiveSha256');
  const tag = `v${version}`;
  assert.equal(release?.tag_name, tag, 'draft tag must match the package');
  assert.equal(release?.draft, true, 'stable promotion starts from a draft');
  const assets = release.assets?.filter(asset => asset.name === `devspace-ultra-${version}.tgz`) ?? [];
  assert.equal(assets.length, 1, 'exactly one candidate archive is required');
  assert.equal(assets[0].digest, `sha256:${archiveSha256}`, 'GitHub archive digest mismatch');
  assert.equal(evidence?.schemaVersion, 1);
  assert.equal(evidence?.version, version, 'evidence version mismatch');
  assert.equal(evidence?.sourceCommit, sourceCommit, 'evidence source commit mismatch');
  assert.equal(evidence?.archiveSha256, archiveSha256, 'evidence archive hash mismatch');
  assert.equal(evidence?.client, 'ChatGPT Classic Windows', 'real product client required');
  assert.equal(evidence?.evidenceKind, 'real-client', 'simulated acceptance is forbidden');
  assert.equal(evidence?.ownerReviewed, true, 'owner review is required');
  const observedAt = Date.parse(evidence.observedAt);
  assert.ok(Number.isFinite(observedAt) && observedAt <= now + 300_000, 'invalid/future observation time');
  for (const name of checkNames) {
    const check = evidence.checks?.[name];
    assert.equal(check?.result, 'pass', `${name}: real-client pass is required`);
    requireHash(check?.evidenceSha256, `${name}.evidenceSha256`);
  }
  const goal = evidence.checks.normalGoal;
  assert.ok(Number.isInteger(goal.observedAssistantTurns) && goal.observedAssistantTurns >= 3);
  assert.equal(goal.additionalHumanMessages, 0, 'Goal must not require human continuation');
  assert.equal(goal.manualBindCalls, 0);
  if (goal.hiddenContinuation !== true) {
    assert.equal(goal.continuationTransport, 'public-component-message');
    assert.equal(goal.publicMessagesAuthorized, true);
    assert.equal(goal.nativeFinalTriggered, true);
    assert.equal(goal.foregroundInputUsed, false);
    assert.equal(goal.focusChanged, false);
    assert.equal(goal.composerMutated, false);
    assert.equal(goal.automaticScroll, false);
    assert.equal(goal.duplicateDispatches, 0);
  }
  assert.equal(evidence.checks.ordinaryTools.disposableReadWriteEditCommandReadback, true);
  const rescue = evidence.checks.automaticRescue;
  assert.equal(rescue.automaticDispatchCount, 1, 'Rescue must dispatch exactly once');
  assert.equal(rescue.manualContinueCount, 0, 'manual recovery is not automatic Rescue');
  assert.equal(rescue.observedAgentWork, true);
  const core = evidence.checks.repeatedCoreReplacement;
  assert.ok(Number.isInteger(core.replacements) && core.replacements >= 2);
  assert.equal(core.duplicateDispatches, 0);
  assert.equal(core.statePreserved, true);
  for (const name of ['freshInstall', 'olderVersionUpgrade']) {
    assert.equal(evidence.checks[name].filesMatchArchive, true, `${name}: accepted payload must match`);
    assert.equal(evidence.checks[name].nativeSqliteLoaded, true);
  }
  const upgrade = evidence.checks.olderVersionUpgrade;
  assert.equal(upgrade.statePreserved, true);
  assert.match(upgrade.fromVersion ?? '', /^\d+\.\d+\.\d+$/);
  const from = upgrade.fromVersion.split('.').map(Number);
  const to = version.split('.').map(Number);
  const difference = from.map((part, index) => part - to[index]).find(part => part !== 0);
  assert.ok(difference < 0, 'upgrade must start from an older release');
  return { ok: true, gate: 'stable-release-real-client-acceptance', version, sourceCommit, archiveSha256 };
}

export async function main(args) {
  assert.equal(args.length, 5, 'Usage: stable-release-acceptance.mjs evidence.json release.json archive.tgz version sourceCommit');
  const [evidencePath, releasePath, archivePath, version, sourceCommit] = args;
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  const archiveSha256 = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  const result = validateAcceptance(evidence, { version, sourceCommit, archiveSha256, release });
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Stable promotion refused: ${error.message}`);
    process.exitCode = 1;
  });
}
