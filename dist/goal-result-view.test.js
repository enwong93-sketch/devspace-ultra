import assert from 'node:assert/strict';
import { goalAcknowledgementView } from './goal-result-view.js';
const report = { round: 2, summary: 'verified evidence '.repeat(200), meaningfulProgress: true, blockerFingerprint: null, reportedAt: '2026-09-21T00:00:00Z' };
const previous = { ...report, round: 1, summary: 'Previous accepted evidence' };
const goal = { id: 'goal-fixture', objective: 'Keep every criterion', successCriteria: [{ id: 'c1', text: 'do not lose history' }],
  lastRoundReport: report, recentReports: [previous, { ...report }], continuation: { state: 'pending', continuationId: 'keep-this-id' } };
const original = structuredClone(goal);
const result = goalAcknowledgementView(goal);
assert.equal(result.omittedDuplicateReports, 1);
assert.deepEqual(result.goal.recentReports, [previous]);
assert.deepEqual(result.goal.lastRoundReport, report);
assert.deepEqual(result.goal.successCriteria, goal.successCriteria);
assert.deepEqual(result.goal.continuation, goal.continuation);
assert.deepEqual(goal, original, 'projection cannot mutate authoritative state');
assert.deepEqual([...result.goal.recentReports, result.goal.lastRoundReport], goal.recentReports, 'all report content remains recoverable');
assert.ok(JSON.stringify(result.goal).length < JSON.stringify(goal).length * 0.6);
assert.equal(goalAcknowledgementView({ ...goal, recentReports: [previous] }).omittedDuplicateReports, 0);
console.log(JSON.stringify({ ok: true, gate: 'goal-result-view', duplicateLatestReportRemoved: true, fullHistoryPreserved: true }));
