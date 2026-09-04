import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = async (path) => await readFile(resolve(root, path), "utf8");

const core = await read("dist/codex-context-bridge.js");
const tools = await read("dist/codex-context-bridge-tools.js");
const server = await read("dist/server.js");
const cli = await read("dist/cli.js");
const pkg = JSON.parse(await read("package.json"));

assert.match(core, /state_5\.sqlite/, "ContextBridge must use Codex authoritative thread metadata DB");
assert.match(core, /thread_history_1\.sqlite/, "ContextBridge must support projected Codex history DB");
assert.match(core, /createReadStream/, "rollout fallback must stream giant JSONL files");
assert.match(core, /createInterface/, "rollout extraction must be line-streamed");
assert.match(core, /record\.type === "compacted"/, "ContextBridge must understand Codex compaction boundaries");
assert.match(core, /payload\.role !== "user" && payload\.role !== "assistant"/, "only user/assistant response messages may enter normal capsule history");
assert.match(core, /hiddenReasoningImported:\s*false/, "capsule must attest hidden reasoning is excluded");
assert.match(core, /developerMessagesImported:\s*false/, "capsule must attest developer messages are excluded");
assert.match(core, /rawToolOutputImported:\s*false/, "capsule must attest raw tool outputs are excluded");
assert.match(core, /REDACTED_SECRET/, "capsule text must receive deterministic obvious-secret redaction");
assert.match(core, /context-bridge[\s\S]*codex/, "sanitized capsules must persist under DevSpace state, not the repository");

assert.match(tools, /context_bridge_codex_list/, "MCP must expose Codex thread selection");
assert.match(tools, /context_bridge_codex_import/, "MCP must expose one-action Codex context hydration");
assert.match(tools, /context_bridge_codex_capsule/, "MCP must expose persisted sanitized capsule reuse");
assert.match(tools, /contextText/, "import tool must place imported context text in the MCP tool result");
assert.doesNotMatch(tools, /toolResult[^\n]*path|rolloutPath/, "MCP surface must not expose local rollout storage paths");

assert.match(server, /createCodexContextBridge/, "DevSpace server must create one shared ContextBridge runtime");
assert.match(server, /registerCodexContextBridgeTools/, "DevSpace MCP sessions must register ContextBridge tools");
assert.match(server, /codexContextBridge\?\.close|codexContextBridge\.close/, "server shutdown must close ContextBridge read-only DB handles");

assert.match(cli, /context[\s\S]*codex/, "CLI must expose Codex ContextBridge commands");
assert.ok(pkg.scripts["verify:context-bridge"], "package must expose verify:context-bridge");
assert.match(pkg.scripts["verify:ultra"], /verify:context-bridge/, "full Ultra verification must include ContextBridge deterministic gates");

console.log(JSON.stringify({ ok: true, gate: "codex-context-bridge-static" }));
