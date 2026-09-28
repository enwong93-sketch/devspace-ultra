import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const bridge = await readFile(new URL("../dist/goal-host-bridge.js", import.meta.url), "utf8");
const tools = await readFile(new URL("../dist/goal-tools.js", import.meta.url), "utf8");

assert.match(bridge, /waitForVisibleReportBoundary/);
assert.match(bridge, /inspectVisibleReportCommit/);
assert.match(bridge, /\/stream_status/);
assert.match(bridge, /latestAssistantText/);
assert.match(bridge, /streamStatus/);
assert.match(bridge, /reportedAt/);
assert.match(bridge, /minimumReportSettleMs/);
assert.match(bridge, /matchesNativeGoalCompletionBoundary/);
assert.match(bridge, /if \(nativeCompletionProof\)/,
  "automatic continuation validates the persisted native final rather than demanding a model-authored report");
assert.match(bridge, /boundary = await this\.waitForVisibleReport\(matching, payload\)/,
  "the optional legacy report path remains available without being the automatic path");
const normalDispatchStart = bridge.indexOf("async dispatch({ goalId");
assert.ok(normalDispatchStart >= 0, "Normal Goal continuation dispatch method must exist.");
const normalDispatch = bridge.slice(normalDispatchStart);
assert.ok(
  normalDispatch.indexOf("if (nativeCompletionProof)") < normalDispatch.indexOf("await this.sendRaw(matching"),
  "the exact native-final path must validate its handoff before raw hidden continuation dispatch.",
);
assert.match(tools, /Optional checkpoint for a Goal round/i);

console.log(JSON.stringify({
  ok: true,
  gate: "goal-visible-report-static",
  nativeAssistantFinalRequired: true,
  modelReportRequired: false,
  optionalManualReportRetained: true,
}));
