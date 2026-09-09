import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SHARED_REGISTRIES = Object.freeze([
  "_registeredResources",
  "_registeredResourceTemplates",
  "_registeredTools",
  "_registeredPrompts",
]);

const INITIALIZATION_FLAGS = Object.freeze([
  "_toolHandlersInitialized",
  "_completionHandlerInitialized",
  "_resourceHandlersInitialized",
  "_promptHandlersInitialized",
]);

function requireTemplate(template) {
  if (!template?.server?._serverInfo || !(template.server._requestHandlers instanceof Map)) {
    throw new Error("A fully registered McpServer template is required.");
  }
  return template;
}

/**
 * Create a transport-local MCP protocol server while sharing the immutable,
 * heavyweight tool/resource/prompt registry and its already-created handlers.
 *
 * The SDK requires one protocol Server per transport because initialization,
 * client capabilities, request ids, logging levels, and pending requests are
 * connection-local. Rebuilding every Zod schema and handler closure for each
 * ChatGPT reconnect is unnecessary and was the dominant Core heap multiplier.
 */
export function createMcpSessionServerFromTemplate(templateInput) {
  const template = requireTemplate(templateInput);
  const session = new McpServer(template.server._serverInfo, {
    instructions: template.server._instructions,
    capabilities: template.server._capabilities,
  });

  for (const key of SHARED_REGISTRIES) {
    session[key] = template[key];
  }
  for (const key of INITIALIZATION_FLAGS) {
    session[key] = template[key] === true;
  }

  // Preserve the session-local initialize/logging handlers created by the new
  // Server constructor. Every other registered request/notification handler is
  // immutable after template construction and can be shared by reference.
  for (const [method, handler] of template.server._requestHandlers) {
    if (!session.server._requestHandlers.has(method)) {
      session.server._requestHandlers.set(method, handler);
    }
  }
  for (const [method, handler] of template.server._notificationHandlers) {
    if (!session.server._notificationHandlers.has(method)) {
      session.server._notificationHandlers.set(method, handler);
    }
  }

  session.server._capabilities = template.server._capabilities;
  session.server.fallbackRequestHandler = template.server.fallbackRequestHandler;
  session.server.fallbackNotificationHandler = template.server.fallbackNotificationHandler;
  return session;
}

export function mcpServerTemplateDiagnostics(templateInput) {
  const template = requireTemplate(templateInput);
  return {
    tools: Object.keys(template._registeredTools || {}).length,
    resources: Object.keys(template._registeredResources || {}).length,
    resourceTemplates: Object.keys(template._registeredResourceTemplates || {}).length,
    prompts: Object.keys(template._registeredPrompts || {}).length,
    requestHandlers: template.server._requestHandlers.size,
    notificationHandlers: template.server._notificationHandlers.size,
  };
}
