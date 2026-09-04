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
const evidenceSchema = z.object({
  criterionId: z.string(),
  evidence: z.string(),
});
const goalSchema = z.object({
  id: z.string(),
  objective: z.string(),
  status: z.enum(["active", "paused", "blocked", "completed", "stopped"]),
  round: z.number().int().positive(),
  roundState: z.enum(["working", "reported"]),
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
const continuationClaimSchema = z.object({
  goalId: z.string(),
  round: z.number().int().positive(),
  continuationId: z.string(),
  leaseId: z.string(),
  expiresAt: z.string(),
  prompt: z.string(),
});
const continuationOutputSchema = {
  goal: goalSchema,
  claim: continuationClaimSchema.optional(),
  acknowledged: z.boolean().optional(),
  released: z.boolean().optional(),
  consumed: z.boolean().optional(),
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
function appOnlyMeta() {
  return { ui: { visibility: ["app"] } };
}

export function registerGoalTools(server, goalRuntime, { resourceUri }) {
  if (!resourceUri) throw new Error("registerGoalTools requires resourceUri.");

  registerAppTool(server, "devspace_goal_start", {
    title: "Start DevSpace Goal",
    description: "Start persistent Goal Mode for a genuine multi-turn objective. Store the full final objective and explicit success criteria once; ordinary steering may change the execution approach but not silently rewrite this Goal.",
    inputSchema: {
      objective: z.string().min(1).max(4_000),
      successCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(12),
    },
    outputSchema: goalOutputSchema,
    annotations: MUTATING,
    _meta: renderMeta(resourceUri),
  }, async ({ objective, successCriteria }) => {
    try {
      const goal = await goalRuntime.start({ objective, successCriteria });
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
  }, async ({ goalId }) => {
    try {
      const goal = await goalRuntime.status(goalId);
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
  }, async ({ goalId, continuationId }) => {
    try {
      const goal = await goalRuntime.roundBegin({ goalId, continuationId });
      return textResult(goal, `Goal ${goal.id} continued into round ${goal.round}.`);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_goal_turn_report", {
    title: "Record Goal Round Report",
    description: "Call this only after you have already given the user the complete visible report for the current Goal round. This records the report gate and, if the Goal remains active, makes one hidden continuation eligible. It must be the final action of the assistant turn.",
    inputSchema: {
      goalId: z.string().min(1),
      summary: z.string().min(1).max(4_000),
      meaningfulProgress: z.boolean(),
      blockerFingerprint: z.string().min(1).max(500).optional(),
    },
    outputSchema: goalOutputSchema,
    annotations: MUTATING,
    _meta: modelOnlyMeta(),
  }, async ({ goalId, summary, meaningfulProgress, blockerFingerprint }) => {
    try {
      const goal = await goalRuntime.turnReport({ goalId, summary, meaningfulProgress, blockerFingerprint });
      return textResult(
        goal,
        `Goal round ${goal.round} report recorded. End this turn now. Emit no additional user-visible text.`,
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
  }, async ({ goalId, evidence }) => {
    try {
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
  }, async ({ goalId }) => {
    try {
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
  }, async ({ goalId, action }) => {
    try {
      const goal = await goalRuntime.control({ goalId, action });
      return textResult(goal, `Goal ${goal.id} is now ${goal.status}.`);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_goal_continuation", {
    title: "Goal Continuation Lease",
    description: "App-only Goal Dock control for atomically claiming, acknowledging, or releasing one hidden continuation dispatch lease.",
    inputSchema: {
      goalId: z.string().min(1),
      action: z.enum(["claim", "ack", "release"]),
      leaseId: z.string().min(1).optional(),
    },
    outputSchema: continuationOutputSchema,
    annotations: MUTATING,
    _meta: appOnlyMeta(),
  }, async ({ goalId, action, leaseId }) => {
    try {
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
    title: "Mount DevSpace Goal Dock",
    description: "Re-mount the latest Goal Dock for an existing Goal after renderer reload, later-turn loss, or another missing-card condition. This is read-only and does not create or change Goal state.",
    inputSchema: { goalId: z.string().min(1) },
    outputSchema: goalOutputSchema,
    annotations: READ_ONLY,
    _meta: renderMeta(resourceUri),
  }, async ({ goalId }) => {
    try {
      const goal = await goalRuntime.status(goalId);
      return textResult(goal, `Mounted Goal ${goal.id} at round ${goal.round}, revision ${goal.revision}.`);
    } catch (error) {
      return errorResult(error);
    }
  });
}
