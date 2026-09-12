import assert from "node:assert/strict";
import { RETIRED_BROWSER_TOOLS, retiredToolCallResult } from "./retired-tool-compat.js";

assert.equal(RETIRED_BROWSER_TOOLS.length, 9);
for (const name of RETIRED_BROWSER_TOOLS) {
  const result = retiredToolCallResult(name);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "retired_tool");
  assert.equal(result.structuredContent.tool, name);
  assert.equal(result.structuredContent.replacementTool, "codex_computer_use");
  assert.equal(result.structuredContent.cachedLegacySchema, true);
  assert.equal(result.structuredContent.otherToolsUnavailable, false);
  assert.match(result.content[0].text, /cached legacy tool list/i);
  assert.match(result.content[0].text, /other DevSpace tools remain available/i);
}

assert.equal(retiredToolCallResult("browser_control_future_tool"), null,
  "unknown future names must not be swallowed by a broad prefix tombstone");
assert.equal(retiredToolCallResult("codex_computer_use"), null);

console.log(JSON.stringify({
  ok: true,
  gate: "retired-tool-compat",
  retiredToolCount: RETIRED_BROWSER_TOOLS.length,
  deterministicReplacement: "codex_computer_use",
  staleSessionMisdiagnosisPrevented: true,
}));
