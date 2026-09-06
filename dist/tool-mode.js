const MODES = new Set(["minimal", "full", "codex", "ultra"]);

export function normalizeToolMode(value, { legacyMinimalTools } = {}) {
  const candidate = value == null || String(value).trim() === ""
    ? (legacyMinimalTools === undefined ? "minimal" : (legacyMinimalTools ? "minimal" : "full"))
    : String(value).trim().toLowerCase();
  if (!MODES.has(candidate)) throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${value}`);
  return candidate;
}

export function toolModeCapabilities(mode) {
  const normalized = normalizeToolMode(mode);
  return {
    legacyWorkspaceTools: normalized !== "codex",
    dedicatedSearchTools: normalized === "full" || normalized === "ultra",
    codexPatchTool: normalized === "codex" || normalized === "ultra",
    codexProcessTools: normalized === "codex" || normalized === "ultra",
  };
}
