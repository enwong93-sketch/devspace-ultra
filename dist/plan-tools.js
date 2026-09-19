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

const stepStatusSchema = z.enum(["pending", "in_progress", "completed"]);
const planStepSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: stepStatusSchema,
});
const planSchema = z.object({
  id: z.string(),
  conversationId: z.string().nullable(),
  title: z.string(),
  status: z.enum(["active", "completed"]),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  lastExplanation: z.string().nullable(),
  steps: z.array(planStepSchema),
});
const planOutputSchema = { plan: planSchema };
const conversationStartClaimSchema = z.object({
  claimId: z.string(),
  toolName: z.enum(["devspace_goal_start", "devspace_plan_start"]),
  expiresAt: z.string(),
  state: z.string(),
});
const planStartOutputSchema = {
  plan: planSchema.optional(),
  pending: z.boolean().optional(),
  claimed: z.boolean().optional(),
  claimId: z.string().optional(),
  conversationStartClaim: conversationStartClaimSchema.optional(),
};

function textResult(plan, text, extra = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent: { plan, ...extra },
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
  };
}

function renderMeta(resourceUri) {
  return {
    ui: {
      resourceUri,
      visibility: ["model"],
    },
  };
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

export function registerPlanTools(server, planRuntime, {
  resourceUri,
  resolveConversation,
  startClaimRegistry = null,
  claimRelayResourceUri = null,
  resolveStartClaimPage = null,
} = {}) {
  if (!resourceUri) throw new Error("registerPlanTools requires resourceUri.");
  const resolveConversationId = async (extra) => {
    if (typeof resolveConversation !== "function") return null;
    const resolved = await resolveConversation(extra);
    return String(resolved?.conversationId || "").trim() || null;
  };

  const pendingStartResult = (claim) => ({
    content: [{
      type: "text",
      text: "Plan start is awaiting exact page-local ownership confirmation. Retry devspace_plan_start once with the returned claimId and the same title/steps before substantive work.",
    }],
    structuredContent: {
      pending: true,
      conversationStartClaim: claim,
    },
    _meta: {
      "devspace/conversationStartClaim": claim,
    },
  });

  registerAppTool(server, "devspace_plan_start", {
    title: "Start DevSpace Plan",
    description: "Start a fresh conversation-bound execution plan for the current physical turn or fresh Goal round when the work is genuinely multi-step. The floating Plan HUD and progress narration card are projected automatically; do not create a legacy inline Plan card. If an active plan already exists from an interrupted turn, resume that active plan with devspace_update_plan instead of creating a duplicate. A completed plan belongs to its finished turn and must not be reused in the next turn.",
    inputSchema: {
      title: z.string().min(1).max(240),
      steps: z.array(z.object({
        text: z.string().min(1).max(500),
        status: stepStatusSchema,
      })).min(2).max(12),
      claimId: z.string().min(16).max(200).optional()
        .describe("Reserved for exact-page ownership recovery after this tool returns a pending conversationStartClaim."),
    },
    outputSchema: planStartOutputSchema,
    annotations: MUTATING,
    _meta: exactPageClaimMeta(claimRelayResourceUri),
  }, async ({ title, steps, claimId }, extra) => {
    try {
      const relayClaimId = String(claimId || "").trim();
      if (relayClaimId) {
        if (!startClaimRegistry) throw new Error("Plan exact-page start recovery is unavailable.");
        const existing = startClaimRegistry.inspect({
          claimId: relayClaimId,
          toolName: "devspace_plan_start",
        });
        if (!existing) throw new Error("Plan start claim is unavailable or expired.");
        if (existing.completed && existing.result?.plan) {
          return textResult(existing.result.plan, `Started plan ${existing.result.plan.id}: ${existing.result.plan.title}`, {
            claimed: true,
            claimId: relayClaimId,
          });
        }
        let resolved = await resolveConversation(extra);
        if (!resolved?.conversationId && typeof resolveStartClaimPage === "function") {
          resolved = await resolveStartClaimPage(relayClaimId);
        }
        if (!resolved?.conversationId) return pendingStartResult(existing);
        const claimed = await startClaimRegistry.claim({
          claimId: relayClaimId,
          toolName: "devspace_plan_start",
          authority: resolved,
          complete: async ({ input, authority }) => ({
            plan: await planRuntime.start({
              title: input.title,
              steps: input.steps,
              conversationId: authority.conversationId,
            }),
          }),
        });
        return textResult(claimed.plan, `Started plan ${claimed.plan.id}: ${claimed.plan.title}`, {
          claimed: true,
          claimId: relayClaimId,
        });
      }
      const conversationId = await resolveConversationId(extra);
      if (typeof resolveConversation === "function" && !conversationId) {
        if (!startClaimRegistry || !claimRelayResourceUri) {
          throw new Error("ChatGPT Classic conversation identity is unresolved; refusing to create an unbound Plan.");
        }
        const claim = startClaimRegistry.create({
          toolName: "devspace_plan_start",
          input: { title, steps },
        });
        return pendingStartResult(claim);
      }
      const plan = await planRuntime.start({ title, steps, conversationId });
      return textResult(plan, `Started plan ${plan.id}: ${plan.title}`);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_update_plan", {
    title: "Update DevSpace Plan",
    description: "Keep the current turn-scoped DevSpace execution plan current as work advances or scope changes. Mark the current in-progress step completed before moving the next step to in_progress, and complete every step before devspace_goal_turn_report in Goal Mode or before the final response in an ordinary turn. This updates backend state only and does not mount another card.",
    inputSchema: {
      planId: z.string().min(1),
      explanation: z.string().min(1).max(2_000).optional(),
      steps: z.array(z.object({
        id: z.string().min(1),
        text: z.string().min(1).max(500),
        status: stepStatusSchema,
      })).min(2).max(12),
    },
    outputSchema: planOutputSchema,
    annotations: MUTATING,
    _meta: modelOnlyMeta(),
  }, async ({ planId, explanation, steps }) => {
    try {
      const plan = await planRuntime.update({ planId, explanation, steps });
      return textResult(plan, `Updated plan ${plan.id} to revision ${plan.revision}.`);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_plan_status", {
    title: "Read DevSpace Plan",
    description: "Read the latest backend-authoritative state of one DevSpace plan. The plan progress widget also uses this tool to refresh itself without creating a new card.",
    inputSchema: {
      planId: z.string().min(1),
    },
    outputSchema: planOutputSchema,
    annotations: READ_ONLY,
    _meta: modelAndAppMeta(),
  }, async ({ planId }) => {
    try {
      const plan = await planRuntime.status(planId);
      return textResult(plan, `Plan ${plan.id} is ${plan.status} at revision ${plan.revision}.`);
    } catch (error) {
      return errorResult(error);
    }
  });

  registerAppTool(server, "devspace_plan_mount", {
    title: "Rebind DevSpace Plan HUD",
    description: "Use this only when the current active turn floating Plan HUD is missing after renderer reload or an interrupt. It rebinds the latest state of that existing active plan without creating or changing the plan and without rendering the retired inline Plan card; completed plans from prior turns should not be remounted.",
    inputSchema: {
      planId: z.string().min(1),
    },
    outputSchema: planOutputSchema,
    annotations: READ_ONLY,
    _meta: modelOnlyMeta(),
  }, async ({ planId }) => {
    try {
      const plan = await planRuntime.status(planId);
      return textResult(plan, `Mounted plan ${plan.id} at revision ${plan.revision}.`);
    } catch (error) {
      return errorResult(error);
    }
  });
}
