import { randomUUID } from "node:crypto";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const installed = new WeakSet();
const POLLING_TOOLS = new Set([
  "devspace_goal_status", "devspace_plan_status", "context_guardian_status",
  "conversation_compact_status", "browser_control_status",
]);

/** Observe the entire tools/call handler, including SDK validation. Never retain payloads. */
export function installGoalToolProgress(server, { supervisor, resolveConversation, observationTimeoutMs = 500 } = {}) {
  if (!supervisor || installed.has(server)) return;
  const protocol = server.server;
  const setRequestHandler = protocol?.setRequestHandler;
  if (typeof setRequestHandler !== "function") throw new Error("Progress instrumentation requires an MCP request handler registry.");
  installed.add(server);
  const timeoutMs = Math.max(10, Math.min(2_000, Number(observationTimeoutMs) || 500));
  async function observe(fn, onTimeout = () => {}) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(fn).catch(() => null),
        new Promise((resolve) => { timer = setTimeout(() => { onTimeout(); resolve(null); }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  // Install before registering tools. Using the public request-handler API also
  // observes SDK input/output validation errors, unlike a callback-only wrapper.
  protocol.setRequestHandler = function (schema, handler) {
    if (schema !== CallToolRequestSchema && schema?.shape?.method?.value !== "tools/call")
      return setRequestHandler.call(this, schema, handler);
    return setRequestHandler.call(this, schema, async function (request, extra) {
      const toolName = request.params?.name;
      if (POLLING_TOOLS.has(toolName)) return handler.apply(this, [request, extra]);
      const identity = await observe(() => resolveConversation?.(extra));
      const observation = new AbortController();
      const context = {
        signal: observation.signal,
        operationId: randomUUID(),
        toolName,
        conversationId: identity?.conversationId || null,
        runtimeKey: identity?.runtimeKey || null,
        goalId: typeof request.params?.arguments?.goalId === "string" ? request.params.arguments.goalId : null,
      };
      await observe(() => supervisor.noteToolStart(context), () => observation.abort());
      const startedAt = performance.now();
      try {
        const result = await handler.apply(this, [request, extra]);
        await observe(() => supervisor.noteToolBoundary({
          ...context,
          // Task-augmented acceptance is not terminal task completion.
          success: result?.task ? null : result != null && result.isError !== true && extra?.signal?.aborted !== true,
          durationMs: performance.now() - startedAt,
        }));
        return result;
      } catch (error) {
        await observe(() => supervisor.noteToolBoundary({ ...context, success: false, durationMs: performance.now() - startedAt }));
        throw error;
      } finally {
        // This aborts only observation, never the tool or native safety handling.
        observation.abort();
      }
    });
  };
}
