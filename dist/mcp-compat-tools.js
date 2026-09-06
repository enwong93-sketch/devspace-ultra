import * as z from "zod/v4";

const READ_ONLY = { readOnlyHint: true };
const PAGE_SIZE = 100;
const MAX_SERVERS = 100;

function textResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { ok: false, error: message },
  };
}

function cursorOffset(cursor) {
  if (cursor == null || cursor === "") return 0;
  const value = Number(cursor);
  if (!Number.isInteger(value) || value < 0) throw new Error("cursor must be a non-negative integer string.");
  return value;
}

function page(items, cursor) {
  const offset = cursorOffset(cursor);
  const values = items.slice(offset, offset + PAGE_SIZE);
  return {
    values,
    nextCursor: offset + values.length < items.length ? String(offset + values.length) : null,
  };
}

async function enabledMcpServers(runtime, { server, probeMcp = true } = {}) {
  const summaries = await runtime.list({ includeDisabled: false, probeMcp: false });
  const rows = [];
  for (const summary of summaries.slice(0, MAX_SERVERS)) {
    const plugin = await runtime.inspect(summary.id, { probeMcp });
    for (const definition of plugin.mcpServers || []) {
      const qualifiedServer = `${plugin.id}/${definition.id}`;
      if (server && definition.id !== server && qualifiedServer !== server) continue;
      rows.push({
        pluginId: plugin.id,
        serverId: definition.id,
        server: definition.id,
        qualifiedServer,
        status: definition.status || "not-probed",
        resources: Array.isArray(definition.resources) ? definition.resources : [],
        resourceTemplates: Array.isArray(definition.resourceTemplates) ? definition.resourceTemplates : [],
      });
    }
  }
  rows.sort((left, right) => left.qualifiedServer.localeCompare(right.qualifiedServer));
  return rows;
}

async function resolveServer(runtime, server) {
  const rows = await enabledMcpServers(runtime, { server, probeMcp: false });
  if (!rows.length) throw new Error(`Unknown or disabled MCP server: ${server}`);
  const exactQualified = rows.filter((row) => row.qualifiedServer === server);
  if (exactQualified.length === 1) return exactQualified[0];
  if (rows.length > 1) {
    throw new Error(`MCP server name ${server} is ambiguous. Use one of: ${rows.map((row) => row.qualifiedServer).join(", ")}`);
  }
  return rows[0];
}

export function registerCodexMcpCompatibilityTools(server, runtime) {
  server.registerTool("list_mcp_resources", {
    title: "List MCP resources",
    description: "List resources from enabled DevSpace capability MCP servers using the Codex-compatible top-level contract. An unqualified server id is accepted only when unique; use pluginId/serverId to disambiguate duplicate server names.",
    inputSchema: {
      server: z.string().min(1).max(360).optional(),
      cursor: z.string().max(32).optional(),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const rows = await enabledMcpServers(runtime, { server: input.server, probeMcp: true });
      const resources = rows.flatMap((row) => row.resources.map((resource) => ({
        server: row.server,
        qualifiedServer: row.qualifiedServer,
        pluginId: row.pluginId,
        serverId: row.serverId,
        ...resource,
      })));
      const result = page(resources, input.cursor);
      return textResult({ ok: true, resources: result.values, nextCursor: result.nextCursor });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("list_mcp_resource_templates", {
    title: "List MCP resource templates",
    description: "List resource templates from enabled DevSpace capability MCP servers using the Codex-compatible top-level contract.",
    inputSchema: {
      server: z.string().min(1).max(360).optional(),
      cursor: z.string().max(32).optional(),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const rows = await enabledMcpServers(runtime, { server: input.server, probeMcp: true });
      const resourceTemplates = rows.flatMap((row) => row.resourceTemplates.map((template) => ({
        server: row.server,
        qualifiedServer: row.qualifiedServer,
        pluginId: row.pluginId,
        serverId: row.serverId,
        ...template,
      })));
      const result = page(resourceTemplates, input.cursor);
      return textResult({ ok: true, resourceTemplates: result.values, nextCursor: result.nextCursor });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("read_mcp_resource", {
    title: "Read MCP resource",
    description: "Read one MCP resource from an enabled trusted DevSpace capability using a Codex-compatible top-level server + URI contract. Use pluginId/serverId when an MCP server id is duplicated.",
    inputSchema: {
      server: z.string().min(1).max(360),
      uri: z.string().min(1).max(8192),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const resolved = await resolveServer(runtime, input.server);
      const result = await runtime.readMcpResource(resolved.pluginId, resolved.serverId, input.uri);
      return textResult({
        ok: true,
        server: resolved.server,
        qualifiedServer: resolved.qualifiedServer,
        pluginId: resolved.pluginId,
        serverId: resolved.serverId,
        uri: input.uri,
        result: result.result,
      });
    } catch (error) {
      return errorResult(error);
    }
  });
}
