import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../dist/ui/plan-card.html", import.meta.url), "utf8");

assert.match(html, /devspace_plan_status/);
assert.match(html, /window\.openai\.callTool/);
assert.match(html, /1500/);
assert.match(html, /document\.visibilityState/);
assert.match(html, /visibilitychange/);
assert.match(html, /plan\.status === "completed"/);
assert.match(html, /TERMINAL_DISMISS_MS/);
assert.match(html, /scheduleTerminalDismiss/);
assert.match(html, /data-dismissed|dataset\.dismissed/);
assert.match(html, /opacity[^;]*140ms|transition[^;]*opacity/i, "completed Plan card must exit with a bounded natural fade instead of remaining as a permanent Completed card");
assert.match(html, /clearTimeout|clearInterval/);
assert.match(html, /window\.openai\??\.widgetState/);
assert.match(html, /window\.openai\??\.setWidgetState/);
assert.match(html, /window\.openai\??\.requestDisplayMode/);
assert.match(html, /mode:\s*"pip"/);
assert.match(html, /--color-text-primary/);
assert.match(html, /--color-background-primary/);
assert.match(html, /openai:set_globals/);
assert.doesNotMatch(html, /<script[^>]+src=/i);
assert.doesNotMatch(html, /<link[^>]+stylesheet/i);

console.log(JSON.stringify({ ok: true, gate: "plan-card-static" }));
