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

function textResult(plan, text) {
  return {
    content: [{ type: "text", text }],
    structuredContent: { plan },
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

export function registerPlanTools(server, planRuntime, { resourceUri, resolveConversation } = {}) {
  if (!resourceUri) throw new Error("registerPlanTools requires resourceUri.");
  const resolveConversationId = async (extra) => {
    if (typeof resolveConversation !== "function") return null;
    const resolved = await resolveConversation(extra);
    const conversationId = String(resolved?.conversationId || "").trim();
    if (!conversationId) {
      throw new Error("ChatGPT Classic conversation identity is unresolved; refusing to create an unbound Plan.");
    }
    return conversationId;
  };

  registerAppTool(server, "devspace_plan_start", {
    title: "Start DevSpace Plan",
    description: "Start a fresh user-visible execution plan for the current physical turn or fresh Goal round when the work is genuinely multi-step. If an active plan already exists from an interrupted turn, resume that active plan with devspace_update_plan instead of creating a duplicate. A completed plan belongs to its finished turn and must not be reused in the next turn.",
    inputSchema: {
      title: z.string().min(1).max(240),
      steps: z.array(z.object({
        text: z.string().min(1).max(500),
        status: stepStatusSchema,
      })).min(2).max(12),
    },
    outputSchema: planOutputSchema,
    annotations: MUTATING,
    _meta: renderMeta(resourceUri),
  }, async ({ title, steps }, extra) => {
    try {
      const conversationId = await resolveConversationId(extra);
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
    title: "Mount DevSpace Plan Card",
    description: "Use this only when the current active turn plan card is missing after renderer reload or an interrupt. It mounts the latest state of that existing active plan without creating or changing the plan; completed plans from prior turns should not be remounted.",
    inputSchema: {
      planId: z.string().min(1),
    },
    outputSchema: planOutputSchema,
    annotations: READ_ONLY,
    _meta: renderMeta(resourceUri),
  }, async ({ planId }) => {
    try {
      const plan = await planRuntime.status(planId);
      return textResult(plan, `Mounted plan ${plan.id} at revision ${plan.revision}.`);
    } catch (error) {
      return errorResult(error);
    }
  });
}
