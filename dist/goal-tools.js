import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { goalAcknowledgementView } from './goal-result-view.js';

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
const turnCompletionSchema = z.object({
  round: z.number().int().positive(),
  source: z.literal("native-assistant-turn-final"),
  conversationId: z.string(),
  runtimeKey: z.string(),
  pageTargetId: z.string(),
  sourceUserMessageId: z.string(),
  assistantMessageId: z.string(),
  assistantTextHash: z.string(),
  assistantCreatedAt: z.string(),
  completedAt: z.string(),
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
  lastTurnCompletion: turnCompletionSchema.nullable().optional(),
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
  resumed: z.boolean().optional(),
  claimId: z.string().optional(),
  conversationStartClaim: conversationStartClaimSchema.optional(),
  nextAction: z.object({ tool: z.literal("devspace_goal_start"), claimId: z.string() }).optional(),
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
  publicMessage: z.object({ goalId: z.string(), conversationId: z.string(), continuationId: z.string(),
    leaseId: z.string(), prompt: z.string(), round: z.number().int().positive() }).optional(),
  claim: continuationClaimSchema.optional(),
  acknowledged: z.boolean().optional(),
  released: z.boolean().optional(),
  consumed: z.boolean().optional(),
  hostDispatch: hostDispatchSchema.optional(),
};

function textResult(goal, text, extra = {}, { fullHistory = false } = {}) {
  const view = fullHistory ? { goal, omittedDuplicateReports: 0 } : goalAcknowledgementView(goal);
  return {
    content: [{ type: "text", text: view.omittedDuplicateReports
      ? text + ' The duplicate latest report is included once as lastRoundReport; recentReports here excludes that duplicate. devspace_goal_status returns the full authoritative history.' : text }],
    structuredContent: { goal: view.goal, ...extra },
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
  completeStartClaim = null,
  resolveProviderIdentity = null,
} = {}) {
  if (!resourceUri) throw new Error("registerGoalTools requires resourceUri.");
  if (!relayResourceUri) throw new Error("registerGoalTools requires relayResourceUri.");

  const resolveConversationId = async (extra) => {
    if (typeof resolveConversation !== "function") return null;
    const resolved = await resolveConversation(extra);
    return String(resolved?.conversationId || "").trim() || null;
  };

  const startResult = async (goal, text, extra = {}) => {
    const result = textResult(goal, text, extra);
    const receipt = await goalRuntime.nativeStartReceipt?.(goal.id);
    if (receipt) result.content.push({ type: 'text',
      text: `[DEVSPACE_NATIVE_GOAL_START:${goal.id}:${receipt.receiptId}]` });
    return result;
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
      nextAction: { tool: "devspace_goal_start", claimId: claim.claimId },
    },
    _meta: {
      "devspace/conversationStartClaim": claim,
    },
  });

  registerAppTool(server, "devspace_goal_start", {
    title: "Start DevSpace Goal",
    description: "Start persistent Goal Mode for a genuine multi-turn objective. Store the full final objective and explicit success criteria once; ordinary steering may change the execution approach but not silently rewrite this Goal. If the result is pending, immediately call this same tool once with the returned nextAction.claimId and the original objective/successCriteria. The Agent performs this bootstrap without asking the user to pair the conversation. The floating Goal strip and progress narration card are projected automatically; do not create the retired inline Goal Dock.",
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
          const resumed = existing.result.resumed === true;
          return {
            ...await startResult(existing.result.goal, `${resumed ? "Resumed" : "Started"} Goal ${existing.result.goal.id} at round ${existing.result.goal.round}.`, {
              claimed: true,
              resumed,
              claimId: relayClaimId,
            }),
          };
        }
        let resolved = await resolveConversation(extra);
        if (!resolved?.conversationId && typeof resolveStartClaimPage === "function") {
          resolved = await resolveStartClaimPage(relayClaimId);
        }
        if (!resolved?.conversationId) return pendingStartResult(existing);
        const claimed = typeof completeStartClaim === "function"
          ? await completeStartClaim({ claimId: relayClaimId, toolName: "devspace_goal_start", authority: resolved })
          : await startClaimRegistry.claim({
              claimId: relayClaimId,
              toolName: "devspace_goal_start",
              authority: resolved,
              complete: async ({ input, authority }) => {
                const start = await goalRuntime.startOrResume({
                  objective: input.objective,
                  successCriteria: input.successCriteria,
                  conversationId: authority.conversationId,
                });
                return { goal: start.goal, resumed: start.resumed };
              },
            });
        if (!claimed?.goal) throw new Error("Exact-page Goal recovery did not return a Goal.");
        const resumed = claimed.resumed === true;
        return await startResult(claimed.goal, `${resumed ? "Resumed" : "Started"} Goal ${claimed.goal.id} at round ${claimed.goal.round}.`, {
          claimed: true,
          resumed,
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
        const providerIdentity = typeof resolveProviderIdentity === "function"
          ? resolveProviderIdentity(extra)
          : null;
        const claim = startClaimRegistry.create({
          toolName: "devspace_goal_start",
          input: { objective, successCriteria },
          providerIdentity,
        });
        return pendingStartResult(claim);
      }
      const goal = await goalRuntime.start({ objective, successCriteria, conversationId });
      return await startResult(goal, `Started Goal ${goal.id} at round ${goal.round}.`);
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
      return textResult(goal, `Goal ${goal.id} is ${goal.status}, round ${goal.round}, ${goal.roundState}.`, {}, { fullHistory: true });
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_goal_round_begin", {
    title: "Begin Continued Goal Round",
    description: "Compatibility reconciliation for a hidden Goal continuation. Current backends normally redeem the next round automatically during exact-page dispatch; cached continuation prompts may still call this endpoint, and duplicate redemption is idempotent.",
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
    description: "Optional checkpoint for a Goal round. It is not required for continuation: DevSpace automatically continues an active, incomplete Goal when the exact native assistant turn ends. Use this only when a concise explicit checkpoint is useful; it never gates ordinary tools or continuation.",
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
        `Goal round ${goal.round} checkpoint recorded. Continue the requested work normally. If the Goal remains active/incomplete when this exact assistant turn ends, DevSpace will continue it automatically.${armed ? (armed.armed ? ' The checkpoint continuation is armed for the exact conversation.' : ` The optional checkpoint relay is ${armed.reason || armed.state}; native turn completion remains the automatic continuation path.`) : ''}`,
      );
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_goal_complete", {
    title: "Complete DevSpace Goal",
    description: "Mark the full Goal completed only when current authoritative evidence covers every stored success criterion. Then give the user a clear final report; no Goal turn-report call is required.",
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
      return textResult(goal, `Goal ${goal.id} is marked completed. Give the user the final visible report.`);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_goal_blocked", {
    title: "Mark DevSpace Goal Blocked",
    description: "Use only when a genuine external dependency or user decision prevents further useful progress. A missing progress report, active/incomplete Plan, or lack of recent progress is not by itself a reason to block the Goal. After marking blocked, explain the concrete blocker to the user.",
    inputSchema: { goalId: z.string().min(1) },
    outputSchema: goalOutputSchema,
    annotations: MUTATING,
    _meta: modelOnlyMeta(),
  }, async ({ goalId }, extra) => {
    try {
      await bindOrVerifyActiveGoal(goalId, extra);
      const goal = await goalRuntime.markBlocked({ goalId });
      return textResult(goal, `Goal ${goal.id} is blocked. Explain the concrete external blocker and what would unblock it.`);
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
    description: "App-only Goal control. Public component messages require a backend-verified native final and an exclusive, durable one-shot delivery claim. RPC success is not proof of a new working round.",
    inputSchema: {
      goalId: z.string().min(1),
      action: z.enum(["dispatch", "claim", "ack", "release", "public_message"]),
      leaseId: z.string().min(1).optional(),
    },
    outputSchema: continuationOutputSchema,
    annotations: MUTATING,
    _meta: appOnlyMeta(),
  }, async ({ goalId, action, leaseId }, extra) => {
    try {
      await bindOrVerifyActiveGoal(goalId, extra);
      if (action === 'public_message') {
        const conversationId = await resolveConversationId(extra);
        const goal = await goalRuntime.status(goalId);
        if (!conversationId || conversationId !== goal.conversationId) throw new Error('Public continuation requires exact authenticated conversation ownership.');
        const publicMessage = await hostBridge?.continuationSupervisor?.claimPublicMessage?.(goalId);
        return textResult(await goalRuntime.status(goalId), publicMessage
          ? 'One public component message authorized; await native continuation receipt.'
          : 'No public component message currently authorized.', publicMessage ? { publicMessage } : {});
      }
      if ((action === "dispatch" || action === "claim") && hostBridge?.continuationSupervisor) {
        const status = await hostBridge.continuationSupervisor.requestDispatch(goalId);
        const goal = await goalRuntime.status(goalId);
        return textResult(goal, `Goal continuation backend state: ${status.state}.`, {
          acknowledged: status.dispatched,
          hostDispatch: { ok: true, transport: 'backend-exact-page-continuation' },
        });
      }
      if (action === "dispatch") {
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
      return textResult(goal, `Mounted Goal ${goal.id} at round ${goal.round}, revision ${goal.revision}.`, {}, { fullHistory: true });
    } catch (error) {
      return errorResult(error);
    }
  });
}
