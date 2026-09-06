import assert from "node:assert/strict";
import { probeImportedCodexMcp } from "./codex-mcp-production-probe.mjs";

const config = String.raw`
[mcp_servers."code-review-graph"]
command = "node"
args = ["graph.mjs"]

[mcp_servers.node_repl]
command = "node"
args = ["repl.mjs"]

[mcp_servers."windows-mcp-elevated"]
command = "node"
args = ["elevated.mjs"]
`;

function plugin(id, enabled, trusted, status = "online", tools = [{ name: "tool" }]) {
  return {
    id,
    enabled,
    trusted,
    mcpServers: [{
      id: id.replace(/^codex-mcp-/, ""),
      type: "stdio",
      status,
      tools,
      prompts: [],
      resources: [],
      resourceTemplates: [],
      probeErrors: {},
    }],
  };
}

{
  const runtime = {
    async inspect(id) {
      if (id === "codex-mcp-code-review-graph") return plugin(id, true, true);
      if (id === "codex-mcp-node_repl") return plugin(id, true, true);
      if (id === "codex-mcp-windows-mcp-elevated") return plugin(id, false, false, "not-probed", []);
      throw new Error("unknown");
    },
  };
  const result = await probeImportedCodexMcp({
    runtime,
    codexConfigText: config,
    requiredNames: ["code-review-graph", "node_repl"],
    timeoutMs: 1_000,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary.requiredFailures, []);
  assert.equal(result.rows.find((row) => row.name === "windows-mcp-elevated").state, "privileged-quarantined");
  assert.equal(result.secretValuesLogged, false);
}

{
  const runtime = {
    async inspect(id) {
      if (id === "codex-mcp-code-review-graph") return plugin(id, true, true, "offline", []);
      if (id === "codex-mcp-node_repl") throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      return plugin(id, true, true);
    },
  };
  const result = await probeImportedCodexMcp({
    runtime,
    codexConfigText: config,
    requiredNames: ["code-review-graph", "node_repl"],
    timeoutMs: 1_000,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.summary.requiredFailures, [
    { name: "code-review-graph", state: "offline-or-empty-catalog" },
    { name: "node_repl", state: "executable-not-found" },
  ]);
  assert.equal(JSON.stringify(result).includes("spawn ENOENT"), false, "raw launch errors must not be echoed into the production report");
}

{
  const runtime = {
    async inspect(id) {
      if (id === "codex-mcp-windows-mcp-elevated") return plugin(id, true, true);
      return plugin(id, true, true);
    },
  };
  const result = await probeImportedCodexMcp({
    runtime,
    codexConfigText: config,
    requiredNames: ["code-review-graph"],
    timeoutMs: 1_000,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.summary.privilegedViolations, ["windows-mcp-elevated"]);
}

console.log(JSON.stringify({
  ok: true,
  gate: "codex-mcp-production-probe",
  requiredFailuresFatal: true,
  privilegedQuarantineRequired: true,
  rawErrorsExcluded: true,
}));
