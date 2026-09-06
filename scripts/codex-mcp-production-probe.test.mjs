import assert from "node:assert/strict";
import { probeLinkedCodexMcp } from "./codex-mcp-production-probe.mjs";

function server(id, {
  runnable = true,
  enabled = true,
  highRisk = false,
  transport = "stdio",
  skipReason = null,
} = {}) {
  return { id, runnable, enabled, highRisk, transport, skipReason };
}

function online(id, tools = [{ name: "tool" }]) {
  return {
    id,
    status: "online",
    tools,
    prompts: [],
    resources: [],
    resourceTemplates: [],
  };
}

{
  const bridge = {
    async catalog() {
      return {
        executionPolicy: "full-access",
        servers: [
          server("code-review-graph"),
          server("node_repl", { highRisk: true }),
          server("windows-mcp-elevated", { highRisk: true }),
          server("devspace", { runnable: false, skipReason: "self recursion" }),
        ],
      };
    },
    async probe(id) {
      return online(id);
    },
    diagnostics() { return { executionPolicy: "full-access" }; },
  };
  const result = await probeLinkedCodexMcp({
    bridge,
    requiredNames: ["code-review-graph", "node_repl"],
    timeoutMs: 1_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.executionPolicy, "full-access");
  assert.deepEqual(result.summary.requiredFailures, []);
  assert.deepEqual(result.summary.highRiskOnline, ["node_repl", "windows-mcp-elevated"]);
  assert.equal(result.rows.find((row) => row.name === "devspace").state, "self-recursion-skipped");
  assert.equal(result.secretValuesLogged, false);
}

{
  const bridge = {
    async catalog() {
      return {
        executionPolicy: "full-access",
        servers: [
          server("code-review-graph"),
          server("node_repl"),
        ],
      };
    },
    async probe(id) {
      if (id === "code-review-graph") return { ...online(id, []), status: "offline" };
      throw Object.assign(new Error("spawn ENOENT with private path"), { code: "ENOENT" });
    },
    diagnostics() { return { executionPolicy: "full-access" }; },
  };
  const result = await probeLinkedCodexMcp({
    bridge,
    requiredNames: ["code-review-graph", "node_repl", "git_bash"],
    timeoutMs: 1_000,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.summary.requiredFailures, [
    { name: "code-review-graph", state: "offline" },
    { name: "git_bash", state: "not-configured" },
    { name: "node_repl", state: "executable-not-found" },
  ]);
  assert.equal(JSON.stringify(result).includes("private path"), false, "raw launch errors must not be echoed into the production report");
}

await assert.rejects(
  () => probeLinkedCodexMcp({
    bridge: {
      async catalog() { return { executionPolicy: "sandboxed", servers: [] }; },
      diagnostics() { return { executionPolicy: "sandboxed" }; },
    },
    requiredNames: [],
  }),
  /must use full-access/i,
);

console.log(JSON.stringify({
  ok: true,
  gate: "codex-mcp-production-probe",
  linkedConfigPrimary: true,
  fullAccessRequired: true,
  highRiskDoesNotAddLocalApproval: true,
  requiredFailuresFatal: true,
  rawErrorsExcluded: true,
}));
