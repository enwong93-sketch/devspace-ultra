import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalRuntime } from "./goal-runtime.js";

const root = await mkdtemp(join(tmpdir(), "devspace-goal-runtime-"));
let nowMs = Date.parse("2026-09-05T00:00:00.000Z");
const now = () => nowMs;
const advance = (ms) => { nowMs += ms; };

try {
  const runtime = new GoalRuntime({ stateDir: root, now });
  await runtime.ready;

  const started = await runtime.start({
    objective: "Finish Goal Mode core",
    successCriteria: [
      "Every physical Goal turn reports before continuation",
      "Completion stops automatic continuation",
    ],
  });

  assert.match(started.id, /^goal_[a-f0-9]{16}$/);
  assert.equal(started.objective, "Finish Goal Mode core");
  assert.equal(started.status, "active");
  assert.equal(started.round, 1);
  assert.equal(started.roundState, "working");
  assert.equal(started.revision, 1);
  assert.equal(started.successCriteria.length, 2);
  assert.ok(started.successCriteria.every((criterion) => /^criterion_[a-f0-9]{16}$/.test(criterion.id)));
  assert.deepEqual(started.successCriteria.map((criterion) => criterion.text), [
    "Every physical Goal turn reports before continuation",
    "Completion stops automatic continuation",
  ]);
  assert.equal(started.continuation.state, "idle");
  assert.equal(started.lastRoundReport, null);
  assert.equal(started.blocker.consecutiveRounds, 0);
  assert.equal((await runtime.activeGoals()).some((goal) => goal.id === started.id), true);

  const status1 = await runtime.status(started.id);
  assert.deepEqual(status1, started);
  status1.objective = "mutated client copy";
  assert.equal((await runtime.status(started.id)).objective, "Finish Goal Mode core");

  advance(1_000);
  const paused = await runtime.control({ goalId: started.id, action: "pause" });
  assert.equal(paused.status, "paused");
  assert.equal(paused.round, 1);
  assert.equal(paused.roundState, "working");
  assert.equal(paused.revision, 2);
  assert.equal(paused.pausedAt, "2026-09-05T00:00:01.000Z");
  assert.equal((await runtime.activeGoals()).some((goal) => goal.id === started.id), false);
  assert.equal((await runtime.projectableGoals()).some((goal) => goal.id === started.id), true);

  await assert.rejects(
    () => runtime.control({ goalId: started.id, action: "pause" }),
    /already paused/i,
  );

  advance(1_000);
  const resumed = await runtime.control({ goalId: started.id, action: "resume" });
  assert.equal(resumed.status, "active");
  assert.equal(resumed.round, 1);
  assert.equal(resumed.roundState, "working");
  assert.equal(resumed.revision, 3);
  assert.equal(resumed.pausedAt, null);
  assert.deepEqual(resumed.successCriteria, started.successCriteria);

  await assert.rejects(
    () => runtime.control({ goalId: started.id, action: "resume" }),
    /already active/i,
  );

  await runtime.close();

  const reloaded = new GoalRuntime({ stateDir: root, now });
  await reloaded.ready;
  const restored = await reloaded.status(started.id);
  assert.deepEqual(restored, resumed);

  const statePath = join(root, "goal-state.json");
  const disk = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(disk.version, 1);
  assert.deepEqual(disk.goals[started.id], resumed);

  advance(1_000);
  const stopped = await reloaded.control({ goalId: started.id, action: "stop" });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.revision, 4);
  assert.equal(stopped.stoppedAt, "2026-09-05T00:00:03.000Z");
  assert.equal(stopped.continuation.state, "idle");

  await assert.rejects(
    () => reloaded.control({ goalId: started.id, action: "resume" }),
    /terminal|stopped/i,
  );
  await assert.rejects(
    () => reloaded.control({ goalId: started.id, action: "pause" }),
    /terminal|stopped/i,
  );
  await assert.rejects(
    () => reloaded.control({ goalId: started.id, action: "stop" }),
    /already stopped|terminal/i,
  );

  await assert.rejects(
    () => reloaded.start({
      objective: " ",
      successCriteria: ["A"],
    }),
    /objective.*required/i,
  );
  await assert.rejects(
    () => reloaded.start({
      objective: "Invalid criteria",
      successCriteria: [],
    }),
    /1-12 success criteria/i,
  );
  await assert.rejects(
    () => reloaded.start({
      objective: "Invalid criteria",
      successCriteria: Array.from({ length: 13 }, (_, index) => `Criterion ${index}`),
    }),
    /1-12 success criteria/i,
  );
  await assert.rejects(
    () => reloaded.status("goal_deadbeefdeadbeef"),
    /unknown goal/i,
  );

  const reportedGoal = await reloaded.start({
    objective: "Verify round reporting",
    successCriteria: ["Round report is durable", "Active report queues continuation"],
  });
  advance(1_000);
  const reported = await reloaded.turnReport({
    goalId: reportedGoal.id,
    summary: "Round one inspected the report gate.",
    meaningfulProgress: false,
    blockerFingerprint: "  Build   Failure  123  ",
  });
  assert.equal(reported.round, 1);
  assert.equal(reported.roundState, "reported");
  assert.equal(reported.lastRoundReport.round, 1);
  assert.equal(reported.lastRoundReport.summary, "Round one inspected the report gate.");
  assert.equal(reported.lastRoundReport.meaningfulProgress, false);
  assert.equal(reported.lastRoundReport.blockerFingerprint, "build failure 123");
  assert.equal(reported.blocker.fingerprint, "build failure 123");
  assert.equal(reported.blocker.consecutiveRounds, 1);
  assert.equal(reported.blocker.lastSeenRound, 1);
  assert.equal(reported.continuation.state, "pending");
  assert.equal(reported.continuation.forRound, 1);
  assert.match(reported.continuation.continuationId, /^continuation_[a-f0-9]{16}$/);

  await assert.rejects(
    () => reloaded.turnReport({
      goalId: reportedGoal.id,
      summary: "Duplicate report",
      meaningfulProgress: false,
      blockerFingerprint: "build failure 123",
    }),
    /already reported/i,
  );
  await assert.rejects(
    () => reloaded.markBlocked({ goalId: reportedGoal.id }),
    /3 consecutive|three consecutive|requires.*3/i,
  );

  const progressGoal = await reloaded.start({
    objective: "Verify blocker reset on progress",
    successCriteria: ["Progress report resets blocker state"],
  });
  const progressReported = await reloaded.turnReport({
    goalId: progressGoal.id,
    summary: "Meaningful work completed in this round.",
    meaningfulProgress: true,
    blockerFingerprint: "ignored because progress happened",
  });
  assert.equal(progressReported.blocker.fingerprint, null);
  assert.equal(progressReported.blocker.consecutiveRounds, 0);
  assert.equal(progressReported.blocker.lastSeenRound, null);

  const completionGoal = await reloaded.start({
    objective: "Verify strict completion audit",
    successCriteria: ["Unit gate passes", "Live state is verified"],
  });
  const [criterionA, criterionB] = completionGoal.successCriteria;

  await assert.rejects(
    () => reloaded.complete({
      goalId: completionGoal.id,
      evidence: [{ criterionId: criterionA.id, evidence: "Unit gate passed." }],
    }),
    /missing evidence|every success criterion|criterion.*evidence/i,
  );
  await assert.rejects(
    () => reloaded.complete({
      goalId: completionGoal.id,
      evidence: [
        { criterionId: criterionA.id, evidence: "Unit gate passed." },
        { criterionId: "criterion_deadbeefdeadbeef", evidence: "Unknown." },
      ],
    }),
    /unknown criterion/i,
  );
  await assert.rejects(
    () => reloaded.complete({
      goalId: completionGoal.id,
      evidence: [
        { criterionId: criterionA.id, evidence: "Unit gate passed." },
        { criterionId: criterionB.id, evidence: "   " },
      ],
    }),
    /evidence.*required/i,
  );

  advance(1_000);
  const completed = await reloaded.complete({
    goalId: completionGoal.id,
    evidence: [
      { criterionId: criterionB.id, evidence: "Observed current live state." },
      { criterionId: criterionA.id, evidence: "Unit gate passed." },
    ],
  });
  assert.equal(completed.status, "completed");
  assert.match(completed.completedAt, /^2026-09-05T/);
  assert.equal(completed.roundState, "working");
  assert.equal(completed.continuation.state, "idle");
  assert.deepEqual(completed.completionEvidence, [
    { criterionId: criterionA.id, evidence: "Unit gate passed." },
    { criterionId: criterionB.id, evidence: "Observed current live state." },
  ]);

  const finalReported = await reloaded.turnReport({
    goalId: completionGoal.id,
    summary: "The Goal is complete and both criteria are verified.",
    meaningfulProgress: true,
  });
  assert.equal(finalReported.status, "completed");
  assert.equal(finalReported.roundState, "reported");
  assert.equal(finalReported.continuation.state, "idle");
  assert.equal(finalReported.lastRoundReport.summary, "The Goal is complete and both criteria are verified.");

  await assert.rejects(
    () => reloaded.turnReport({
      goalId: completionGoal.id,
      summary: "Duplicate final report",
      meaningfulProgress: true,
    }),
    /already reported/i,
  );
  await assert.rejects(
    () => reloaded.complete({
      goalId: completionGoal.id,
      evidence: completed.completionEvidence,
    }),
    /terminal|already completed/i,
  );

  const leaseGoal = await reloaded.start({
    objective: "Verify continuation lease recovery",
    successCriteria: ["Only one continuation lease is active", "Expired dispatch recovers"],
  });
  const leaseReported = await reloaded.turnReport({
    goalId: leaseGoal.id,
    summary: "Round one is ready to continue.",
    meaningfulProgress: true,
  });
  const leaseContinuationId = leaseReported.continuation.continuationId;
  const claim1 = await reloaded.continuation({ goalId: leaseGoal.id, action: "claim" });
  assert.equal(claim1.goal.continuation.state, "dispatching");
  assert.equal(claim1.claim.continuationId, leaseContinuationId);
  assert.match(claim1.claim.leaseId, /^lease_[a-f0-9]{16}$/);
  assert.match(claim1.claim.prompt, /DEVSPACE_GOAL_CONTINUATION/);
  assert.match(claim1.claim.prompt, /devspace_goal_round_begin/);
  assert.match(claim1.claim.prompt, /devspace_goal_turn_report/);
  assert.match(claim1.claim.prompt, /devspace_goal_turn_report.*before.*visible.*final report/i);
  assert.match(claim1.claim.prompt, /do not call.*(?:more|additional).*tool.*after.*devspace_goal_turn_report/i);
  assert.match(claim1.claim.prompt, new RegExp(leaseGoal.id));
  assert.match(claim1.claim.prompt, new RegExp(leaseContinuationId));

  await assert.rejects(
    () => reloaded.continuation({ goalId: leaseGoal.id, action: "claim" }),
    /already.*dispatch|lease|not pending/i,
  );
  await assert.rejects(
    () => reloaded.continuation({ goalId: leaseGoal.id, action: "release", leaseId: "lease_deadbeefdeadbeef" }),
    /lease/i,
  );

  const released = await reloaded.continuation({
    goalId: leaseGoal.id,
    action: "release",
    leaseId: claim1.claim.leaseId,
  });
  assert.equal(released.goal.continuation.state, "pending");
  assert.equal(released.goal.continuation.continuationId, leaseContinuationId);

  const claim2 = await reloaded.continuation({ goalId: leaseGoal.id, action: "claim" });
  advance(45_001);
  const leaseExpired = await reloaded.status(leaseGoal.id);
  assert.equal(leaseExpired.continuation.state, "pending");
  assert.equal(leaseExpired.continuation.continuationId, leaseContinuationId);

  const claim3 = await reloaded.continuation({ goalId: leaseGoal.id, action: "claim" });
  const acked = await reloaded.continuation({
    goalId: leaseGoal.id,
    action: "ack",
    leaseId: claim3.claim.leaseId,
  });
  assert.equal(acked.goal.continuation.state, "dispatched");
  assert.equal(acked.acknowledged, true);
  assert.equal(acked.consumed, false);
  advance(120_001);
  const dispatchRecovered = await reloaded.status(leaseGoal.id);
  assert.equal(dispatchRecovered.continuation.state, "pending");
  assert.equal(dispatchRecovered.continuation.continuationId, leaseContinuationId);

  const raceGoal = await reloaded.start({
    objective: "Verify round redemption races",
    successCriteria: ["Round begins once", "Late ack is harmless"],
  });
  const raceReported = await reloaded.turnReport({
    goalId: raceGoal.id,
    summary: "Round one reported.",
    meaningfulProgress: true,
  });
  const raceClaim = await reloaded.continuation({ goalId: raceGoal.id, action: "claim" });
  const raceContinuationId = raceReported.continuation.continuationId;
  advance(10_000);

  const raceRound2 = await reloaded.roundBegin({
    goalId: raceGoal.id,
    continuationId: raceContinuationId,
  });
  assert.equal(raceRound2.round, 2);
  assert.equal(raceRound2.roundState, "working");
  assert.equal(raceRound2.continuation.state, "idle");
  assert.equal(raceRound2.lastConsumedContinuationId, raceContinuationId);

  const lateAck = await reloaded.continuation({
    goalId: raceGoal.id,
    action: "ack",
    leaseId: raceClaim.claim.leaseId,
  });
  assert.equal(lateAck.acknowledged, true);
  assert.equal(lateAck.consumed, true);
  assert.equal(lateAck.goal.round, 2);

  const duplicateRoundBegin = await reloaded.roundBegin({
    goalId: raceGoal.id,
    continuationId: raceContinuationId,
  });
  assert.equal(duplicateRoundBegin.round, 2);
  assert.equal(duplicateRoundBegin.revision, raceRound2.revision);

  const observedHumanStart = new Date(
    Date.parse(raceReported.lastRoundReport.reportedAt) + 1_000,
  ).toISOString();
  const correctedRoundBegin = await reloaded.roundBegin({
    goalId: raceGoal.id,
    continuationId: raceContinuationId,
    roundBeganAt: observedHumanStart,
  });
  assert.equal(correctedRoundBegin.round, 2);
  assert.equal(correctedRoundBegin.roundBeganAt, observedHumanStart,
    "a later native branch observation may repair the current round boundary backwards");
  assert.equal(correctedRoundBegin.revision, raceRound2.revision + 1);
  const duplicateCorrection = await reloaded.roundBegin({
    goalId: raceGoal.id,
    continuationId: raceContinuationId,
    roundBeganAt: observedHumanStart,
  });
  assert.equal(duplicateCorrection.revision, correctedRoundBegin.revision,
    "replaying the same observed human boundary remains idempotent");
  await assert.rejects(() => reloaded.roundBegin({
    goalId: raceGoal.id,
    continuationId: raceContinuationId,
    roundBeganAt: new Date(Date.parse(raceReported.lastRoundReport.reportedAt) - 60_000).toISOString(),
  }), /predates the reported continuation boundary/i);
  await assert.rejects(() => reloaded.roundBegin({
    goalId: raceGoal.id,
    continuationId: raceContinuationId,
    roundBeganAt: new Date(nowMs + 120_000).toISOString(),
  }), /future/i);

  assert.equal(typeof correctedRoundBegin.roundBeganAt, "string");
  assert.equal(raceRound2.roundRecovery?.state, "idle");
  const recoverable = await reloaded.recoverableWorkingRounds();
  assert.equal(recoverable.some((goal) => goal.id === raceGoal.id), true);

  const recovery1 = await reloaded.claimRoundRecovery({ goalId: raceGoal.id });
  assert.equal(recovery1.claimed, true);
  assert.equal(recovery1.goal.round, 2);
  assert.equal(recovery1.goal.roundState, "working");
  assert.equal(recovery1.goal.roundRecovery.state, "dispatching");
  assert.equal(recovery1.claim.round, 2);
  assert.match(recovery1.claim.recoveryId, /^recovery_[a-f0-9]{16}$/);
  assert.match(recovery1.claim.prompt, /DEVSPACE_GOAL_ROUND_RECOVERY/);
  assert.match(recovery1.claim.prompt, /same working round 2/i);
  assert.match(recovery1.claim.prompt, /do not call devspace_goal_round_begin/i);
  assert.match(recovery1.claim.prompt, /devspace_goal_turn_report/i);

  const duplicateRecoveryClaim = await reloaded.claimRoundRecovery({ goalId: raceGoal.id });
  assert.equal(duplicateRecoveryClaim.claimed, false);
  assert.equal(duplicateRecoveryClaim.reason, "recovery-in-flight");

  const recoveryRelease = await reloaded.roundRecovery({
    goalId: raceGoal.id,
    action: "release",
    recoveryId: recovery1.claim.recoveryId,
  });
  assert.equal(recoveryRelease.goal.roundRecovery.state, "idle");
  assert.equal(recoveryRelease.released, true);

  const coolingRecovery = await reloaded.claimRoundRecovery({ goalId: raceGoal.id });
  assert.equal(coolingRecovery.claimed, false);
  assert.equal(coolingRecovery.reason, "recovery-cooldown");

  advance(5_001);
  const recovery2 = await reloaded.claimRoundRecovery({ goalId: raceGoal.id });
  assert.equal(recovery2.claimed, true);
  assert.equal(recovery2.claim.attempt, 2);
  const recoveryAck = await reloaded.roundRecovery({
    goalId: raceGoal.id,
    action: "ack",
    recoveryId: recovery2.claim.recoveryId,
  });
  assert.equal(recoveryAck.goal.roundRecovery.state, "dispatched");
  assert.equal(recoveryAck.acknowledged, true);

  const duplicateAfterAck = await reloaded.claimRoundRecovery({ goalId: raceGoal.id });
  assert.equal(duplicateAfterAck.claimed, false);
  assert.equal(duplicateAfterAck.reason, "recovery-already-dispatched");
  advance(30_001);
  const duplicateAfterTime = await reloaded.claimRoundRecovery({ goalId: raceGoal.id });
  assert.equal(duplicateAfterTime.claimed, false,
    "one successfully visible recovery message must permanently close the current Goal round recovery episode");
  assert.equal(duplicateAfterTime.reason, "recovery-already-dispatched");

  const raceRound2Reported = await reloaded.turnReport({
    goalId: raceGoal.id,
    summary: "Round two recovered and completed after an interrupted assistant turn.",
    meaningfulProgress: true,
  });
  assert.equal(raceRound2Reported.roundState, "reported");
  assert.equal(raceRound2Reported.roundRecovery.state, "idle");
  assert.equal((await reloaded.recoverableWorkingRounds()).some((goal) => goal.id === raceGoal.id), false);
  assert.equal(raceRound2Reported.continuation.state, "pending");

  const retryGoal = await reloaded.start({
    objective: "Recover automatically after transient Goal recovery preflight failures",
    successCriteria: ["Recovery attempts resume after the bounded cooldown instead of leaving a working round permanently dead"],
  });
  const retryRound1Reported = await reloaded.turnReport({
    goalId: retryGoal.id,
    summary: "Round one prepared the automatic recovery retry test.",
    meaningfulProgress: true,
  });
  const retryLease = await reloaded.continuation({ goalId: retryGoal.id, action: "claim" });
  await reloaded.roundBegin({
    goalId: retryGoal.id,
    continuationId: retryRound1Reported.continuation.continuationId,
  });
  await reloaded.continuation({
    goalId: retryGoal.id,
    action: "ack",
    leaseId: retryLease.claim.leaseId,
  });
  for (let expectedAttempt = 1; expectedAttempt <= 5; expectedAttempt += 1) {
    const claimed = await reloaded.claimRoundRecovery({ goalId: retryGoal.id });
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.claim.attempt, expectedAttempt);
    await reloaded.roundRecovery({
      goalId: retryGoal.id,
      action: "release",
      recoveryId: claimed.claim.recoveryId,
    });
    advance(5_001);
  }
  const recoveredAfterBurstCap = await reloaded.claimRoundRecovery({ goalId: retryGoal.id });
  assert.equal(recoveredAfterBurstCap.claimed, true,
    "transient preflight failures must not permanently strand a working Goal round after the cooldown");
  assert.equal(recoveredAfterBurstCap.claim.attempt, 1,
    "the exhausted transient-attempt burst restarts from attempt one after cooldown");
  await reloaded.roundRecovery({
    goalId: retryGoal.id,
    action: "ack",
    recoveryId: recoveredAfterBurstCap.claim.recoveryId,
  });

  const blockedGoal = await reloaded.start({
    objective: "Verify strict repeated blocker guard",
    successCriteria: ["Three reported rounds are required before blocked"],
  });
  const blockerText = "Dependency Service Offline";
  let blockedState = await reloaded.turnReport({
    goalId: blockedGoal.id,
    summary: "Round 1 could not progress because the dependency is offline.",
    meaningfulProgress: false,
    blockerFingerprint: blockerText,
  });
  assert.equal(blockedState.blocker.consecutiveRounds, 1);
  await assert.rejects(() => reloaded.markBlocked({ goalId: blockedGoal.id }), /3 consecutive/i);

  for (let expectedRound = 2; expectedRound <= 3; expectedRound += 1) {
    const claim = await reloaded.continuation({ goalId: blockedGoal.id, action: "claim" });
    const begun = await reloaded.roundBegin({
      goalId: blockedGoal.id,
      continuationId: claim.claim.continuationId,
    });
    assert.equal(begun.round, expectedRound);
    blockedState = await reloaded.turnReport({
      goalId: blockedGoal.id,
      summary: `Round ${expectedRound} confirmed the same dependency remains offline.`,
      meaningfulProgress: false,
      blockerFingerprint: " dependency   service offline ",
    });
    assert.equal(blockedState.blocker.consecutiveRounds, expectedRound);
    if (expectedRound < 3) {
      await assert.rejects(() => reloaded.markBlocked({ goalId: blockedGoal.id }), /3 consecutive/i);
    }
  }

  const blockerClaim = await reloaded.continuation({ goalId: blockedGoal.id, action: "claim" });
  const blockerRound4 = await reloaded.roundBegin({
    goalId: blockedGoal.id,
    continuationId: blockerClaim.claim.continuationId,
  });
  assert.equal(blockerRound4.round, 4);
  const markedBlocked = await reloaded.markBlocked({ goalId: blockedGoal.id });
  assert.equal(markedBlocked.status, "blocked");
  assert.equal(markedBlocked.blocker.consecutiveRounds, 3);
  assert.equal(markedBlocked.continuation.state, "idle");
  const blockedReport = await reloaded.turnReport({
    goalId: blockedGoal.id,
    summary: "Goal is blocked after three confirmed rounds with the same blocker.",
    meaningfulProgress: false,
    blockerFingerprint: blockerText,
  });
  assert.equal(blockedReport.status, "blocked");
  assert.equal(blockedReport.continuation.state, "idle");

  const changedBlockerGoal = await reloaded.start({
    objective: "Verify blocker fingerprint reset",
    successCriteria: ["Changed blocker restarts count"],
  });
  let changed = await reloaded.turnReport({
    goalId: changedBlockerGoal.id,
    summary: "First blocker report.",
    meaningfulProgress: false,
    blockerFingerprint: "blocker A",
  });
  let changedClaim = await reloaded.continuation({ goalId: changedBlockerGoal.id, action: "claim" });
  await reloaded.roundBegin({ goalId: changedBlockerGoal.id, continuationId: changedClaim.claim.continuationId });
  changed = await reloaded.turnReport({
    goalId: changedBlockerGoal.id,
    summary: "Same blocker again.",
    meaningfulProgress: false,
    blockerFingerprint: "blocker A",
  });
  assert.equal(changed.blocker.consecutiveRounds, 2);
  changedClaim = await reloaded.continuation({ goalId: changedBlockerGoal.id, action: "claim" });
  await reloaded.roundBegin({ goalId: changedBlockerGoal.id, continuationId: changedClaim.claim.continuationId });
  changed = await reloaded.turnReport({
    goalId: changedBlockerGoal.id,
    summary: "A different blocker replaced the earlier one.",
    meaningfulProgress: false,
    blockerFingerprint: "blocker B",
  });
  assert.equal(changed.blocker.fingerprint, "blocker b");
  assert.equal(changed.blocker.consecutiveRounds, 1);

  await reloaded.close();

  {
    const boundRoot = await mkdtemp(join(tmpdir(), "devspace-goal-conversation-bound-"));
    try {
      const bound = new GoalRuntime({ stateDir: boundRoot, now });
      await bound.ready;
      const legacyGoal = await bound.start({
        objective: "Legacy unbound Goal",
        successCriteria: ["Legacy remains readable"],
      });
      assert.equal(legacyGoal.conversationId, null);

      const goalA = await bound.start({
        conversationId: "conversation-a",
        objective: "Conversation A Goal",
        successCriteria: ["Stay in conversation A"],
      });
      const goalB = await bound.start({
        conversationId: "conversation-b",
        objective: "Conversation B Goal",
        successCriteria: ["Stay in conversation B"],
      });
      assert.equal(goalA.conversationId, "conversation-a");
      assert.equal(goalB.conversationId, "conversation-b");
      assert.deepEqual((await bound.activeGoals({ conversationId: "conversation-a" })).map((goal) => goal.id), [goalA.id]);
      assert.deepEqual((await bound.projectableGoals({ conversationId: "conversation-b" })).map((goal) => goal.id), [goalB.id]);
      assert.equal((await bound.activeGoals()).length, 3, "unfiltered legacy diagnostics may still see all active Goals");

      const boundLegacy = await bound.bindConversation({ goalId: legacyGoal.id, conversationId: "conversation-legacy" });
      assert.equal(boundLegacy.conversationId, "conversation-legacy", "a legacy unbound Goal may be bound exactly once after native authority proves the conversation");
      await assert.rejects(
        () => bound.bindConversation({ goalId: legacyGoal.id, conversationId: "conversation-other" }),
        /already bound|conversation-legacy|different conversation/i,
        "a Goal may never silently migrate to another conversation after binding",
      );
      const idempotent = await bound.bindConversation({ goalId: legacyGoal.id, conversationId: "conversation-legacy" });
      assert.equal(idempotent.conversationId, "conversation-legacy");

      const rebound = await bound.rebindConversation({
        goalId: legacyGoal.id,
        oldConversationId: "conversation-legacy",
        newConversationId: "conversation-continuation",
      });
      assert.equal(rebound.conversationId, "conversation-continuation");
      assert.equal(rebound.conversationContinuity.at(-1).from, "conversation-legacy");
      assert.equal(rebound.conversationContinuity.at(-1).to, "conversation-continuation");
      assert.deepEqual((await bound.activeGoals({ conversationId: "conversation-legacy" })).map((goal) => goal.id), []);
      assert.deepEqual((await bound.activeGoals({ conversationId: "conversation-continuation" })).map((goal) => goal.id), [legacyGoal.id]);
      await assert.rejects(
        () => bound.rebindConversation({ goalId: legacyGoal.id, oldConversationId: "conversation-wrong", newConversationId: "conversation-other" }),
        /not expected source/i,
      );
      const reboundIdempotent = await bound.rebindConversation({
        goalId: legacyGoal.id,
        oldConversationId: "conversation-legacy",
        newConversationId: "conversation-continuation",
      });
      assert.equal(reboundIdempotent.conversationId, "conversation-continuation");

      const boundReloaded = new GoalRuntime({ stateDir: boundRoot, now });
      await boundReloaded.ready;
      assert.equal((await boundReloaded.status(goalA.id)).conversationId, "conversation-a");
      assert.equal((await boundReloaded.status(legacyGoal.id)).conversationId, "conversation-continuation");
      assert.equal((await boundReloaded.status(legacyGoal.id)).conversationContinuity.length, 1);
      await boundReloaded.close();
      await bound.close();
    } finally {
      await rm(boundRoot, { recursive: true, force: true });
    }
  }

  const corruptRoot = await mkdtemp(join(tmpdir(), "devspace-goal-corrupt-"));
  try {
    await writeFile(join(corruptRoot, "goal-state.json"), "{not valid json", "utf8");
    const corruptRuntime = new GoalRuntime({ stateDir: corruptRoot, now });
    await corruptRuntime.ready;
    const fresh = await corruptRuntime.start({
      objective: "Recover after corrupt state",
      successCriteria: ["Runtime boots"],
    });
    assert.equal(fresh.round, 1);
    await corruptRuntime.close();
  } finally {
    await rm(corruptRoot, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    gate: "goal-runtime-core",
    persisted: true,
    restartRecovered: true,
    controls: ["pause", "resume", "stop"],
    terminalStopped: true,
    reportOnce: true,
    completionCoverage: true,
    blockerFoundation: true,
    exclusiveLease: true,
    releaseRecovery: true,
    ackRace: true,
    roundBeginIdempotent: true,
    dispatchRecovery: true,
    blockedThreeRounds: true,
    conversationBound: true,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
