import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [server, parity, bridge, capability, packageJson] = await Promise.all([
  readFile(new URL("../dist/server.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/codex-parity-tools.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/codex-mcp-bridge.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/capability-runtime.js", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
]);

assert.match(server, /ToolCatalogRegistry, instrumentToolRegistration/);
assert.match(server, /registerCodexParityTools/);
assert.match(server, /CodexMcpBridge, registerCodexMcpBridgeTools/);
assert.match(server, /new CodexMcpBridge\(\{ codexHome: config\.agentDir, executionPolicy: \"full-access\" \}\)/);
assert.match(server, /registerCodexMcpBridgeTools\(server, codexMcpBridge\)/);
assert.match(server, /await codexMcpBridge\.close\(\)/);
const instrumentIndex = server.indexOf("instrumentToolRegistration(server, toolCatalog)");
const firstGoalProgressIndex = server.indexOf("installGoalToolProgress(server");
const parityRegistrationIndex = server.indexOf("registerCodexParityTools(server");
assert.ok(instrumentIndex >= 0 && instrumentIndex < firstGoalProgressIndex, "tool catalogue must observe every subsequent Core tool registration");
assert.ok(parityRegistrationIndex > instrumentIndex, "Codex parity tools must be registered through the instrumented catalogue");

for (const name of [
  "view_image",
  "request_user_input",
  "current_time",
  "sleep",
  "get_context_remaining",
  "tool_search",
]) {
  assert.match(parity, new RegExp(`registerTool\\(\\"${name}\\"`), `missing ${name}`);
}
for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
  assert.match(capability, new RegExp(`registerTool\\(\\"${name}\\"`), `missing ${name}`);
}
assert.match(parity, /await exactUsageAuthority\.status\(\{ conversationId \}\)/);
assert.match(parity, /source:\s*available \? "classic-native-protocol" : "unavailable"/);
assert.match(parity, /Fresh exact Classic-native usage evidence is unavailable/);
assert.doesNotMatch(parity, /hostMeasuredTokens|ledgerTokens[^\n]*remainingTokens|snapshotTokens[^\n]*remainingTokens/);
assert.match(parity, /realpath\(workspace\.root\)/);
assert.match(parity, /isPathInsideRoot\(resolvedPath, rootPath\)/);
assert.match(parity, /server\.server\.elicitInput/);
assert.match(capability, /tool-only MCP|empty resource list means the server has no callable tools|supported: false/);
for (const name of [
  "codex_mcp_catalog",
  "codex_mcp_refresh",
  "codex_mcp_inspect",
  "codex_mcp_call",
  "codex_mcp_list_resources",
  "codex_mcp_list_resource_templates",
  "codex_mcp_read_resource",
]) {
  assert.match(bridge, new RegExp(`registerTool\\(\\"${name}\\"`), `missing ${name}`);
}
assert.match(bridge, /inlineBearerTokenRejected/);
assert.match(bridge, /RECURSIVE_OR_DUPLICATE_IDS/);
assert.match(bridge, /environmentNames/);
assert.match(bridge, /executionPolicy/);
assert.match(bridge, /full-access/);
assert.match(bridge, /configuredApprovalMode/);
assert.match(bridge, /HIGH_RISK_SERVER_PATTERN/);
assert.doesNotMatch(server, /registerCodexSandboxTools|CodexSandboxRuntime|request_permissions|exec_sandboxed/);
assert.match(server, /computer-use/);
assert.match(server, /@oai\/sky/);
assert.match(server, /existing Codex node_repl/);
assert.match(packageJson, /"smol-toml"/);

console.log(JSON.stringify({
  ok: true,
  gate: "codex-parity-static",
  imageInspection: true,
  structuredUserInput: true,
  genericMcpResources: true,
  unifiedToolSearch: true,
  exactContextFailsClosed: true,
  linkedCodexMcpCatalog: true,
  secretsNotCopied: true,
  fullAccessOnly: true,
  computerUseRouting: true,
}));
