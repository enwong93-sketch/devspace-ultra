import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [operations, runtime] = await Promise.all([
  readFile(new URL("./chat-swarm-classic-operations.ps1", import.meta.url), "utf8"),
  readFile(new URL("../dist/chat-swarm-classic-runtime.js", import.meta.url), "utf8"),
]);

assert.match(operations, /\$port = 9330 \+ \$Number/, "operations must use the isolated Worker CDP port range, not any Main port");
assert.match(operations, /UTF8Encoding/, "operator metadata must be UTF-8 safe");
assert.match(operations, /secretValuesLogged=\$false/, "operations output must explicitly exclude secrets");
assert.doesNotMatch(operations, /Start-Process|Stop-Process|SetForegroundWindow/, "read-only operations metadata must not control windows or processes");
assert.match(runtime, /chat_swarm_classic_overview/);
assert.match(runtime, /chat_swarm_classic_diagnostics/);
assert.match(runtime, /chat_swarm_classic_worker_metadata/);
assert.match(runtime, /chat_swarm_classic_quick_action/);
assert.match(runtime, /protected-runtime safeguards/);
console.log(JSON.stringify({ ok: true, gate: "classic-operations-static", workerAutostart: false, routingMetadataOnly: true }));
