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
assert.match(bridge, /await this\.waitForVisibleReport\(matching, payload\)/);
const normalDispatchStart = bridge.indexOf("async dispatch({ goalId");
assert.ok(normalDispatchStart >= 0, "Normal Goal continuation dispatch method must exist.");
const normalDispatch = bridge.slice(normalDispatchStart);
assert.ok(
  normalDispatch.indexOf("await this.waitForVisibleReport(matching, payload)") < normalDispatch.indexOf("await this.sendRaw(matching"),
  "Visible report commit gate must run before raw hidden continuation dispatch.",
);
assert.match(tools, /reportedAt:\s*claimed\.goal\?\.lastRoundReport\?\.reportedAt/);

console.log(JSON.stringify({
  ok: true,
  gate: "goal-visible-report-static",
  serverCompleteRequired: true,
  visibleAssistantRequired: true,
  reportTimestampPropagated: true,
}));
