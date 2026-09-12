export const RETIRED_BROWSER_TOOLS = Object.freeze([
  "browser_control_pair",
  "browser_control_status",
  "browser_control_claim",
  "browser_control_release",
  "browser_control_inspect",
  "browser_control_act",
  "browser_control_navigate",
  "browser_control_wait",
  "browser_control_cdp",
]);

const RETIRED_BROWSER_TOOL_SET = new Set(RETIRED_BROWSER_TOOLS);

export function retiredToolCallResult(toolName, { currentProductionVersion = "0.5.6" } = {}) {
  const selected = String(toolName || "").trim();
  if (!RETIRED_BROWSER_TOOL_SET.has(selected)) return null;
  const message = `DevSpace tool ${selected} was removed from the current production schema. This conversation is using a cached legacy tool list; other DevSpace tools remain available. Refresh the MCP tool list or start a fresh turn, then use codex_computer_use.`;
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: {
      ok: false,
      code: "retired_tool",
      tool: selected,
      replacementTool: "codex_computer_use",
      currentProductionVersion,
      cachedLegacySchema: true,
      refreshRequired: true,
      otherToolsUnavailable: false,
    },
  };
}
