import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const criterionSchema = z.object({
  id: z.string(),
  text: z.string(),
});
const roundReportSchema = z.object({
  round: z.number().int().positive(),
  summary: z.string(),
  meaningfulProgress: z.boolean(),
  blockerFingerprint: z.string().nullable(),
  reportedAt: z.string(),
});
const blockerSchema = z.object({
  fingerprint: z.string().nullable(),
  consecutiveRounds: z.number().int().nonnegative(),
  lastSeenRound: z.number().int().positive().nullable(),
});
const continuationSchema = z.object({
  state: z.enum(["idle", "pending", "dispatching", "dispatched"]),
  forRound: z.number().int().positive().nullable(),
  continuationId: z.string().nullable(),
  leaseId: z.string().nullable(),
  leasedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  dispatchedAt: z.string().nullable(),
});
const roundRecoverySchema = z.object({
  state: z.enum(["idle", "dispatching", "dispatched"]),
  round: z.number().int().positive(),
  recoveryId: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  claimedAt: z.string().nullable(),
  dispatchedAt: z.string().nullable(),
  retryAfterAt: z.string().nullable(),
});
const evidenceSchema = z.object({
  criterionId: z.string(),
  evidence: z.string(),
});
const goalSchema = z.object({
  id: z.string(),
  conversationId: z.string().nullable(),
  objective: z.string(),
  status: z.enum(["active", "paused", "blocked", "completed", "stopped"]),
  round: z.number().int().positive(),
  roundState: z.enum(["working", "reported"]),
  roundBeganAt: z.string().nullable(),
  roundRecovery: roundRecoverySchema,
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  blockedAt: z.string().nullable(),
  successCriteria: z.array(criterionSchema),
  lastRoundReport: roundReportSchema.nullable(),
  recentReports: z.array(roundReportSchema),
  completionEvidence: z.array(evidenceSchema).nullable(),
  blocker: blockerSchema,
  continuation: continuationSchema,
  lastConsumedContinuationId: z.string().nullable(),
  lastConsumedLeaseId: z.string().nullable(),
});
const goalOutputSchema = { goal: goalSchema };
const conversationStartClaimSchema = z.object({
  claimId: z.string(),
  toolName: z.enum(["devspace_goal_start", "devspace_plan_start"]),
  expiresAt: z.string(),
  state: z.string(),
});
const goalStartOutputSchema = {
  goal: goalSchema.optional(),
  pending: z.boolean().optional(),
  claimed: z.boolean().optional(),
  claimId: z.string().optional(),
  conversationStartClaim: conversationStartClaimSchema.optional(),
};
const continuationClaimSchema = z.object({
  goalId: z.string(),
  round: z.number().int().positive(),
  continuationId: z.string(),
  leaseId: z.string(),
  expiresAt: z.string(),
  prompt: z.string(),
});
const hostDispatchSchema = z.object({
  ok: z.boolean(),
  transport: z.string().optional(),
  runtimeLabel: z.string().optional(),
  runtimePort: z.number().int().positive().optional(),
  targetId: z.string().optional(),
});
const continuationOutputSchema = {
  goal: goalSchema,
  claim: continuationClaimSchema.optional(),
  acknowledged: z.boolean().optional(),
  released: z.boolean().optional(),
  consumed: z.boolean().optional(),
  hostDispatch: hostDispatchSchema.optional(),
};

function textResult(goal, text, extra = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent: { goal, ...extra },
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function renderMeta(resourceUri) {
  return { ui: { resourceUri, visibility: ["model"] } };
}
function modelOnlyMeta() {
  return { ui: { visibility: ["model"] } };
}
function modelAndAppMeta() {
  return { ui: { visibility: ["model", "app"] } };
}
function exactPageClaimMeta(resourceUri) {
  return resourceUri
    ? { ui: { resourceUri, visibility: ["model", "app"] } }
    : modelOnlyMeta();
}
function appOnlyMeta() {
  return { ui: { visibility: ["app"] } };
}

export function registerGoalTools(server, goalRuntime, {
  resourceUri,
  relayResourceUri,
  hostBridge,
  onMount,
  resolveConversation,
  resolveBootstrapConversation = null,
  startClaimRegistry = null,
  claimRelayResourceUri = null,
  resolveStartClaimPage = null,
} = {}) {
  if (!resourceUri) throw new Error("registerGoalTools requires resourceUri.");
  if (!relayResourceUri) throw new Error("registerGoalTools requires relayResourceUri.");

  const resolveConversationId = async (extra) => {
    if (typeof resolveConversation !== "function") return null;
    const resolved = await resolveConversation(extra);
    return String(resolved?.conversationId || "").trim() || null;
  };

  const bindOrVerifyActiveGoal = async (goalId, extra) => {
    let goal = await goalRuntime.status(goalId);
    const conversationId = await resolveConversationId(extra);
    if (!conversationId) return goal;
    if (goal.conversationId && goal.conversationId !== conversationId) {
      throw new Error(`Goal ${goal.id} belongs to conversation ${goal.conversationId}, not ${conversationId}.`);
    }
    if (!goal.conversationId && goal.status === "active" && typeof goalRuntime.bindConversation === "function") {
      goal = await goalRuntime.bindConversation({ goalId: goal.id, conversationId });
    }
    return goal;
  };

  const pendingStartResult = (claim) => ({
    content: [{
      type: "text",
      text: "Goal Mode start is awaiting exact page-local ownership confirmation. Retry devspace_goal_start once with the returned claimId and the same objective/successCriteria before substantive work.",
    }],
    structuredContent: {
      pending: true,
      conversationStartClaim: claim,
    },
    _meta: {
      "devspace/conversationStartClaim": claim,
    },
  });

  registerAppTool(server, "devspace_goal_start", {
    title: "Start DevSpace Goal",
    description: "Start persistent Goal Mode for a genuine multi-turn objective. Store the full final objective and explicit success criteria once; ordinary steering may change the execution approach but not silently rewrite this Goal. The floating Goal strip and progress narration card are projected automatically; do not create the retired inline Goal Dock.",
    inputSchema: {
      objective: z.string().min(1).max(4_000),
      successCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(12),
      claimId: z.string().min(16).max(200).optional()
        .describe("Reserved for exact-page ownership recovery after this tool returns a pending conversationStartClaim."),
    },
    outputSchema: goalStartOutputSchema,
    annotations: MUTATING,
    _meta: exactPageClaimMeta(claimRelayResourceUri),
  }, async ({ objective, successCriteria, claimId }, extra) => {
    try {
      const relayClaimId = String(claimId || "").trim();
      if (relayClaimId) {
        if (!startClaimRegistry) throw new Error("Goal exact-page start recovery is unavailable.");
        const existing = startClaimRegistry.inspect({
          claimId: relayClaimId,
          toolName: "devspace_goal_start",
        });
        if (!existing) throw new Error("Goal start claim is unavailable or expired.");
        if (existing.completed && existing.result?.goal) {
          return {
            ...textResult(existing.result.goal, `Started Goal ${existing.result.goal.id} at round ${existing.result.goal.round}.`, {
              claimed: true,
              claimId: relayClaimId,
            }),
          };
        }
        let resolved = await resolveConversation(extra);
        if (!resolved?.conversationId && typeof resolveStartClaimPage === "function") {
          resolved = await resolveStartClaimPage(relayClaimId);
        }
        if (!resolved?.conversationId) return pendingStartResult(existing);
        const claimed = await startClaimRegistry.claim({
          claimId: relayClaimId,
          toolName: "devspace_goal_start",
          authority: resolved,
          complete: async ({ input, authority }) => ({
            goal: await goalRuntime.start({
              objective: input.objective,
              successCriteria: input.successCriteria,
              conversationId: authority.conversationId,
            }),
          }),
        });
        return textResult(claimed.goal, `Started Goal ${claimed.goal.id} at round ${claimed.goal.round}.`, {
          claimed: true,
          claimId: relayClaimId,
        });
      }
      let conversationId = await resolveConversationId(extra);
      if (!conversationId && typeof resolveBootstrapConversation === "function") {
        const bootstrap = await resolveBootstrapConversation(extra, "devspace_goal_start");
        conversationId = String(bootstrap?.conversationId || "").trim() || null;
      }
      if (typeof resolveConversation === "function" && !conversationId) {
        if (!startClaimRegistry || !claimRelayResourceUri) {
          throw new Error("ChatGPT Classic conversation identity is unresolved; refusing to create an unbound Goal.");
        }
        const claim = startClaimRegistry.create({
          toolName: "devspace_goal_start",
          input: { objective, successCriteria },
        });
        return pendingStartResult(claim);
      }
      const goal = await goalRuntime.start({ objective, successCriteria, conversationId });
      return textResult(goal, `Started Goal ${goal.id} at round ${goal.round}.`);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_goal_status", {
    title: "Read DevSpace Goal",
    description: "Read the latest backend-authoritative Goal state. The Goal Dock also uses this read-only tool to refresh itself.",
    inputSchema: { goalId: z.string().min(1) },
    outputSchema: goalOutputSchema,
    annotations: READ_ONLY,
    _meta: modelAndAppMeta(),
  }, async ({ goalId }, extra) => {
    try {
      const goal = await bindOrVerifyActiveGoal(goalId, extra);
      return textResult(goal, `Goal ${goal.id} is ${goal.status}, round ${goal.round}, ${goal.roundState}.`);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_goal_round_begin", {
    title: "Begin Continued Goal Round",
    description: "Redeem the hidden Goal continuation at the start of an automatically continued assistant turn. The continuation prompt provides both IDs. Call this before substantive work in that continued turn.",
    inputSchema: {
      goalId: z.string().min(1),
      continuationId: z.string().min(1),
    },
    outputSchema: goalOutputSchema,
    annotations: MUTATING,
    _meta: modelOnlyMeta(),
  }, async ({ goalId, continuationId }, extra) => {
    try {
      await bindOrVerifyActiveGoal(goalId, extra);
      const goal = await goalRuntime.roundBegin({ goalId, continuationId });
      return textResult(goal, `Goal ${goal.id} continued into round ${goal.round}.`);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_goal_turn_report", {
    title: "Record Goal Round Report",
    description: "Call this after the current Goal round has finished its work and verification, immediately before the user-visible final report. This records the report gate and, if the Goal remains active, makes one hidden continuation eligible. This must be the final tool call of the turn; after it returns, emit one complete visible final report and call no more tools.",
    inputSchema: {
      goalId: z.string().min(1),
      summary: z.string().min(1).max(4_000),
      meaningfulProgress: z.boolean(),
      blockerFingerprint: z.string().min(1).max(500).optional(),
    },
    outputSchema: goalOutputSchema,
    annotations: MUTATING,
    _meta: renderMeta(relayResourceUri),
  }, async ({ goalId, summary, meaningfulProgress, blockerFingerprint }, extra) => {
    try {
      await bindOrVerifyActiveGoal(goalId, extra);
      const goal = await goalRuntime.turnReport({ goalId, summary, meaningfulProgress, blockerFingerprint });
      const reportAuthority = goal.status === 'active' && typeof resolveBootstrapConversation === 'function'
        ? await resolveBootstrapConversation(extra, 'devspace_goal_turn_report').catch(() => null) : null;
      const armed = goal.status === 'active' && hostBridge?.continuationSupervisor
        ? await hostBridge.continuationSupervisor.arm(goal, { reportAuthority }).catch(() => ({ armed: false, reason: 'source-boundary-capture-failed' }))
        : null;
      return textResult(
        goal,
        `Goal round ${goal.round} report recorded. Now give the user the complete visible report for this round as your final response. Do not call any more tools in this turn.${armed ? (armed.armed ? ' The backend will dispatch one minimal continuation only after this exact user turn has a new completed final report; on the next turn inspect Goal status and continue its already-working round.' : ` Automatic continuation is not armed: ${armed.reason || armed.state}.`) : ''}`,
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_goal_complete", {
    title: "Complete DevSpace Goal",
    description: "Mark the full Goal completed only when current authoritative evidence covers every stored success criterion. Normally call this before the final visible user report, then finish that physical turn with devspace_goal_turn_report after the report is visible.",
    inputSchema: {
      goalId: z.string().min(1),
      evidence: z.array(z.object({
        criterionId: z.string().min(1),
        evidence: z.string().min(1).max(4_000),
      })).min(1).max(12),
    },
    outputSchema: goalOutputSchema,
    annotations: MUTATING,
    _meta: modelOnlyMeta(),
  }, async ({ goalId, evidence }, extra) => {
    try {
      await bindOrVerifyActiveGoal(goalId, extra);
      const goal = await goalRuntime.complete({ goalId, evidence });
      return textResult(goal, `Goal ${goal.id} is marked completed. Give the user the final visible report, then record that round report.`);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_goal_blocked", {
    title: "Mark DevSpace Goal Blocked",
    description: "Mark the Goal blocked only after the runtime has recorded at least three consecutive no-progress reported rounds with the same normalized blocker. After marking blocked, give the user a visible blocked report and finish with devspace_goal_turn_report.",
    inputSchema: { goalId: z.string().min(1) },
    outputSchema: goalOutputSchema,
    annotations: MUTATING,
    _meta: modelOnlyMeta(),
  }, async ({ goalId }, extra) => {
    try {
      await bindOrVerifyActiveGoal(goalId, extra);
      const goal = await goalRuntime.markBlocked({ goalId });
      return textResult(goal, `Goal ${goal.id} is blocked after ${goal.blocker.consecutiveRounds} consecutive blocker rounds.`);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_goal_control", {
    title: "Control DevSpace Goal",
    description: "Pause, resume, or stop an existing Goal. The Goal Dock uses this tool. The model may use pause/stop only when the user explicitly requests that control action.",
    inputSchema: {
      goalId: z.string().min(1),
      action: z.enum(["pause", "resume", "stop"]),
    },
    outputSchema: goalOutputSchema,
    annotations: MUTATING,
    _meta: modelAndAppMeta(),
  }, async ({ goalId, action }, extra) => {
    try {
      await bindOrVerifyActiveGoal(goalId, extra);
      const goal = await goalRuntime.control({ goalId, action });
      if (action === 'resume' && hostBridge?.continuationSupervisor) {
        await hostBridge.continuationSupervisor.arm(goal, { resume: true });
      }
      return textResult(goal, `Goal ${goal.id} is now ${goal.status}.`);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_goal_continuation", {
    title: "Goal Continuation Lease",
    description: "App-only Goal control for dispatching one hidden continuation through the local ChatGPT Classic host bridge, plus low-level lease claim/ack/release recovery actions.",
    inputSchema: {
      goalId: z.string().min(1),
      action: z.enum(["dispatch", "claim", "ack", "release"]),
      leaseId: z.string().min(1).optional(),
    },
    outputSchema: continuationOutputSchema,
    annotations: MUTATING,
    _meta: appOnlyMeta(),
  }, async ({ goalId, action, leaseId }, extra) => {
    try {
      await bindOrVerifyActiveGoal(goalId, extra);
      if (action === "dispatch") {
        if (hostBridge?.continuationSupervisor) {
          const status = await hostBridge.continuationSupervisor.requestDispatch(goalId);
          const goal = await goalRuntime.status(goalId);
          return textResult(goal, `Goal continuation backend state: ${status.state}.`, {
            acknowledged: status.dispatched,
            hostDispatch: { ok: true, transport: 'backend-exact-page-continuation' },
          });
        }
        if (!hostBridge || typeof hostBridge.dispatch !== "function") {
          throw new Error("ChatGPT Classic Goal host bridge is unavailable.");
        }
        const claimed = await goalRuntime.continuation({ goalId, action: "claim" });
        const claim = claimed.claim;
        if (!claim?.leaseId || !claim?.prompt) {
          throw new Error("Goal continuation claim is incomplete.");
        }
        let hostDispatch;
        try {
          hostDispatch = await hostBridge.dispatch({
            goalId,
            round: claim.round,
            continuationId: claim.continuationId,
            leaseId: claim.leaseId,
            prompt: claim.prompt,
            reportedAt: claimed.goal?.lastRoundReport?.reportedAt ?? null,
            conversationId: claimed.goal?.conversationId ?? null,
          });
        } catch (error) {
          if (error?.definiteFailure === true) {
            await goalRuntime.continuation({ goalId, action: "release", leaseId: claim.leaseId });
          }
          throw error;
        }
        if (hostDispatch?.ok !== true) {
          if (hostDispatch?.definiteFailure === true) {
            await goalRuntime.continuation({ goalId, action: "release", leaseId: claim.leaseId });
          }
          throw new Error(hostDispatch?.error || "ChatGPT Classic Goal host dispatch failed.");
        }
        const acknowledged = await goalRuntime.continuation({ goalId, action: "ack", leaseId: claim.leaseId });
        return textResult(acknowledged.goal, `Dispatched Goal ${goalId} continuation through ChatGPT Classic host bridge.`, {
          acknowledged: acknowledged.acknowledged,
          consumed: acknowledged.consumed,
          hostDispatch,
        });
      }

      const result = await goalRuntime.continuation({ goalId, action, leaseId });
      const text = action === "claim"
        ? `Claimed Goal ${goalId} continuation lease.`
        : action === "ack"
          ? `Acknowledged Goal ${goalId} continuation dispatch.`
          : `Released Goal ${goalId} continuation lease.`;
      return textResult(result.goal, text, {
        ...(result.claim ? { claim: result.claim } : {}),
        ...(result.acknowledged !== undefined ? { acknowledged: result.acknowledged } : {}),
        ...(result.released !== undefined ? { released: result.released } : {}),
        ...(result.consumed !== undefined ? { consumed: result.consumed } : {}),
      });
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_goal_mount", {
    title: "Rebind DevSpace Goal Overlay",
    description: "Rebind the latest floating Goal strip for an existing Goal after renderer reload, later-turn loss, deleted-owner recovery, or another missing-overlay condition. This is read-only for Goal state and does not render the retired inline Goal Dock; when Host Overlay is enabled, the explicit mount may briefly arm exact runtime+conversation owner recovery.",
    inputSchema: { goalId: z.string().min(1) },
    outputSchema: goalOutputSchema,
    annotations: READ_ONLY,
    _meta: modelOnlyMeta(),
  }, async ({ goalId }, extra) => {
    try {
      const goal = await bindOrVerifyActiveGoal(goalId, extra);
      if (typeof onMount === "function") {
        try { await onMount({ goal }); } catch {}
      }
      return textResult(goal, `Mounted Goal ${goal.id} at round ${goal.round}, revision ${goal.revision}.`);
    } catch (error) {
      return errorResult(error);
    }
  });
}
