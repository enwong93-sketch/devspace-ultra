import assert from "node:assert/strict";
import {
  codexMcpExecutionFingerprint,
  createCodexMcpBridgeManifest,
  discoverCodexMcpCatalog,
  parseCodexMcpConfig,
  publicCodexMcpCatalog,
  sanitizeCodexMcpServer,
} from "./codex-mcp-config.js";

const fixture = String.raw`
model = "gpt-test"

[mcp_servers.safe]
command = "node"
args = ["server.js", "--port", "8848"]
cwd = 'C:\\tools\\safe'
env = { API_KEY = "top-secret-value", PORT = "8848" }
env_vars = ["HOME", "TEMP"]

[mcp_servers."danger-elevated"]
command = "powershell.exe"
args = ["-File", "admin.ps1"]

[mcp_servers.leaky]
command = "node"
args = ["server.js", "--api-key=literal-secret"]

[mcp_servers.remote]
url = "https://example.invalid/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
[mcp_servers.remote.http_headers]
X-Tenant = "private-tenant"

[mcp_servers.devspace]
command = "devspace"
args = ["serve"]

[mcp_servers.disabled]
enabled = false
command = "node"
args = ["disabled.js"]
`;

const parsed = parseCodexMcpConfig(fixture);
assert.equal(parsed.safe.command, "node");
assert.deepEqual(parsed.safe.args, ["server.js", "--port", "8848"]);
assert.equal(parsed.safe.env.API_KEY, "top-secret-value");
assert.equal(parsed["danger-elevated"].command, "powershell.exe");
assert.equal(parsed.remote.http_headers["X-Tenant"], "private-tenant");

const catalog = discoverCodexMcpCatalog(fixture);
const safe = catalog.find((server) => server.name === "safe");
assert.equal(safe.status, "importable-stdio");
assert.deepEqual(safe.envKeys, ["API_KEY", "PORT"]);
assert.deepEqual(safe.envVars, ["HOME", "TEMP"]);
assert.equal(safe.highRisk, false);
assert.equal(catalog.find((server) => server.name === "danger-elevated").highRisk, true);
assert.equal(catalog.find((server) => server.name === "leaky").status, "blocked-command-line-secret");
assert.equal(catalog.find((server) => server.name === "remote").status, "remote-review-required");
assert.equal(catalog.find((server) => server.name === "devspace").status, "skipped-existing-native");
assert.equal(catalog.find((server) => server.name === "disabled").status, "skipped-disabled");

const publicCatalog = publicCodexMcpCatalog(catalog);
const publicText = JSON.stringify(publicCatalog);
assert.equal(publicText.includes("top-secret-value"), false);
assert.equal(publicText.includes("private-tenant"), false);
assert.equal(publicText.includes("literal-secret"), false);
assert.equal(publicCatalog.find((server) => server.name === "safe").commandBasename, "node");

const manifest = createCodexMcpBridgeManifest(safe, {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  bridgeScriptPath: "C:\\devspace\\scripts\\codex-mcp-stdio-bridge.mjs",
  configPath: "C:\\Users\\tester\\.codex\\config.toml",
});
const manifestText = JSON.stringify(manifest);
assert.equal(manifest.id, "codex-mcp-safe");
assert.equal(manifestText.includes("top-secret-value"), false);
assert.equal(manifestText.includes("API_KEY"), false, "generated manifests must not persist even environment key names unless the bridge needs them");
assert.equal(manifest.mcpServers.safe.command.endsWith("node.exe"), true);
assert.equal(manifest.mcpServers.safe.args.includes(safe.executionFingerprint), true);

const rotatedSecret = sanitizeCodexMcpServer("safe", {
  command: "node",
  args: ["server.js", "--port", "8848"],
  cwd: String.raw`C:\tools\safe`,
  env: { API_KEY: "rotated", PORT: "9999" },
  env_vars: ["HOME", "TEMP"],
});
assert.equal(codexMcpExecutionFingerprint(rotatedSecret), safe.executionFingerprint, "secret rotation must not require re-trusting an unchanged executable surface");
const changedCommand = sanitizeCodexMcpServer("safe", {
  command: "node",
  args: ["other-server.js"],
  env: { API_KEY: "rotated" },
  env_vars: ["HOME", "TEMP"],
});
assert.notEqual(changedCommand.executionFingerprint, safe.executionFingerprint);

assert.throws(
  () => createCodexMcpBridgeManifest(catalog.find((server) => server.name === "leaky"), { nodePath: "node", bridgeScriptPath: "bridge" }),
  /not safely importable/i,
);

console.log(JSON.stringify({
  ok: true,
  gate: "codex-mcp-config",
  quotedTables: true,
  multilineArrays: true,
  secretValuesExcluded: true,
  commandLineSecretsBlocked: true,
  highRiskFlagged: true,
  executableSurfaceFingerprint: true,
}));
