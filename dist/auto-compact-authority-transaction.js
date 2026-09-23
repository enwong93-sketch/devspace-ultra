function cleanId(value, max = 240) {
  const text = String(value ?? "").replace(/\u0000/g, "").trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Apply one verified Auto Compact authority migration as an idempotent,
 * compensating transaction. A Core may restart after any completed step, so
 * every participant accepts either the exact source or exact target owner.
 * Only mutations performed by this invocation are compensated on failure.
 */
export async function applyVerifiedAutoCompactRollover({
  event,
  conversationAuthority,
  goalRuntime,
  planRuntime,
  goalRunProgress,
  hostOverlayProjection,
  now = () => new Date(),
} = {}) {
  const oldConversationId = cleanId(event?.oldConversationId);
  const newConversationId = cleanId(event?.newConversationId);
  const goalId = cleanId(event?.goalId);
  const planId = cleanId(event?.planId);
  const runtimeKey = cleanId(event?.runtimeKey, 80);
  if (!oldConversationId || !newConversationId || oldConversationId === newConversationId || !runtimeKey) {
    throw new Error("Verified Auto Compact rollover is missing distinct conversation ids or runtime identity.");
  }
  if (!conversationAuthority?.acceptVerifiedRollover
    || !goalRuntime?.status
    || !planRuntime?.status
    || !goalRunProgress?.rebindConversation) {
    throw new Error("Verified Auto Compact rollover dependencies are unavailable.");
  }

  const goalBefore = goalId ? await goalRuntime.status(goalId) : null;
  const planBefore = planId ? await planRuntime.status(planId) : null;
  if (goalBefore && ![oldConversationId, newConversationId].includes(goalBefore.conversationId)) {
    throw new Error(`Goal ${goalId} no longer matches Auto Compact source or target conversation.`);
  }
  if (planBefore && ![oldConversationId, newConversationId].includes(planBefore.conversationId)) {
    throw new Error(`Plan ${planId} no longer matches Auto Compact source or target conversation.`);
  }

  let authorityMoved = false;
  let planMoved = false;
  let goalMoved = false;
  let progressMoved = false;
  try {
    const observed = now();
    const authority = await conversationAuthority.acceptVerifiedRollover({
      oldConversationId,
      newConversationId,
      runtimeKey,
      observedAt: event?.rollover?.observedAt
        || (observed instanceof Date ? observed.toISOString() : new Date(observed).toISOString()),
    });
    authorityMoved = authority.alreadyApplied !== true && Number(authority.updatedSessions || 0) > 0;

    if (planBefore) {
      planMoved = planBefore.conversationId === oldConversationId;
      await planRuntime.rebindConversation({ planId, oldConversationId, newConversationId });
    }
    if (goalBefore) {
      goalMoved = goalBefore.conversationId === oldConversationId;
      await goalRuntime.rebindConversation({ goalId, oldConversationId, newConversationId });
    }

    const progress = await goalRunProgress.rebindConversation({
      goalId,
      planId,
      oldConversationId,
      newConversationId,
      runtimeKey,
    });
    progressMoved = Number(progress?.rebind?.changedRuns || 0) > 0
      || Number(progress?.rebind?.changedInFlight || 0) > 0
      || progress?.rebind?.activeChanged === true;

    if (goalBefore) {
      const overlayAccepted = await hostOverlayProjection?.noteVerifiedRollover?.({
        goalId,
        runtimeKey,
        oldConversationId,
        newConversationId,
      });
      if (overlayAccepted !== true) {
        throw new Error("Host Overlay owner could not move to the verified Auto Compact continuation.");
      }
    }

    return {
      ok: true,
      oldConversationId,
      newConversationId,
      goalId,
      planId,
      runtimeKey,
      authoritySessionsMoved: authority.updatedSessions,
      authorityAlreadyApplied: authority.alreadyApplied === true,
      progressMoved,
      overlayMoved: goalBefore ? true : null,
      recoveredAfterRestart: goalBefore?.conversationId === newConversationId
        || planBefore?.conversationId === newConversationId
        || authority.alreadyApplied === true,
    };
  } catch (error) {
    if (progressMoved) {
      await goalRunProgress.rebindConversation({
        goalId,
        planId,
        oldConversationId: newConversationId,
        newConversationId: oldConversationId,
        runtimeKey,
      }).catch(() => {});
    }
    if (goalMoved) {
      await goalRuntime.rebindConversation({
        goalId,
        oldConversationId: newConversationId,
        newConversationId: oldConversationId,
        reason: "auto-compact-rollback",
      }).catch(() => {});
    }
    if (planMoved) {
      await planRuntime.rebindConversation({
        planId,
        oldConversationId: newConversationId,
        newConversationId: oldConversationId,
        reason: "auto-compact-rollback",
      }).catch(() => {});
    }
    if (authorityMoved) {
      await conversationAuthority.acceptVerifiedRollover({
        oldConversationId: newConversationId,
        newConversationId: oldConversationId,
        runtimeKey,
      }).catch(() => {});
    }
    throw error;
  }
}

