import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(source, /registerAppResource\(server, "DevSpace Plan Card", PLAN_CARD_URI,/);
assert.match(source, /new URL\("\.\/ui\/plan-card\.html", import\.meta\.url\)/);
assert.match(source, /mimeType: RESOURCE_MIME_TYPE/);
assert.match(source, /text: planCardHtml\(\)/);
assert.match(source, /description: "Persistent live progress card for a DevSpace execution plan\."/);

const registrationIndex = source.indexOf('registerAppResource(server, "DevSpace Plan Card"');
const toolsIndex = source.indexOf("registerPlanTools(server, planRuntime");
assert.ok(registrationIndex >= 0 && toolsIndex > registrationIndex, "Plan card resource must be registered before its tools.");

console.log(JSON.stringify({ ok: true, gate: "plan-resource-static" }));
