#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../dist/config.js";
import { GoalRuntime } from "../dist/goal-runtime.js";
import { PlanRuntime } from "../dist/plan-runtime.js";
import { ClassicExactUsageAuthority } from "../dist/classic-exact-usage-authority.js";

const MIB = 1024 * 1024;
const LOG_PATTERN = /(?:\.log|\.out|\.err|\.jsonl|\.ndjson|trace|history)(?:\.\d+)?$/i;

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? String(process.argv[index + 1]) : fallback;
}

async function json(url) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return await response.json();
}

async function activePlans(runtime) {
  if (typeof runtime.activePlans === "function") return await runtime.activePlans({ limit: 100 });
  if (typeof runtime.list === "function") return await runtime.list({ status: "active", limit: 100 });
  throw new Error("PlanRuntime has no active Plan reader.");
}

async function logStats(root, maxDepth = 5) {
  const pending = [{ path: resolve(root), depth: 0 }];
  const rows = [];
  while (pending.length && rows.length < 10_000) {
    const current = pending.shift();
    let entries;
    try { entries = await readdir(current.path, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const path = resolve(current.path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (current.depth < maxDepth) pending.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !LOG_PATTERN.test(entry.name)) continue;
      try {
        const info = await stat(path);
        rows.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
      } catch {}
    }
  }
  return {
    root: resolve(root),
    files: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    largestBytes: Math.max(0, ...rows.map((row) => row.bytes)),
  };
}

const goalId = argument("goal-id", "goal_1b2f3eb499d8f460");
const configDir = resolve(argument("config-dir", join(homedir(), ".devspace-tailscale-bootstrap")));
const config = loadConfig({ ...process.env, DEVSPACE_CONFIG_DIR: configDir });
const gatewayPort = Number(config.stableGatewayPort || config.port || 7678);

assert.equal(config.classicHostOverlayEnabled, true, "Classic Host Overlay must be production-enabled.");
assert.equal(config.contextGuardianEnabled, true, "Context Guardian must be production-enabled.");
assert.equal(config.classicStreamRecoveryEnabled, true, "Classic Stream Recovery must be production-enabled.");
assert.equal(config.autoCompactEnabled, true, "Native Auto Compact must be production-enabled.");
assert.equal(Number(config.contextGuardianThresholdPercent || 90), 90, "Native Auto Compact threshold must be 90%.");

const [gatewayHealth, coreHealth, memory, autoCompact] = await Promise.all([
  json(`http://127.0.0.1:${gatewayPort}/__devspace/gateway/healthz`),
  json(`http://127.0.0.1:${gatewayPort}/healthz`),
  json(`http://127.0.0.1:${gatewayPort}/__devspace/memory/status`),
  json(`http://127.0.0.1:${gatewayPort}/__devspace/auto-compact/status`),
]);
assert.equal(gatewayHealth.ok, true);
assert.equal(coreHealth.ok, true);
assert.equal(coreHealth.executionPolicy?.mode, "danger-full-access");
assert.equal(coreHealth.executionPolicy?.approvalPolicy, "never");
assert.equal(coreHealth.executionPolicy?.sandboxEnabled, false);
assert.deepEqual(coreHealth.executionPolicy?.alternativeModes, []);

const heapUsed = Number(memory?.memory?.heapUsed || 0);
const heapLimit = Number(memory?.memory?.heapSizeLimit || 0);
assert.ok(heapLimit > 0 && heapLimit <= 512 * MIB, `Production Core heap limit is not bounded to 512 MiB: ${heapLimit}.`);
assert.ok(heapUsed < heapLimit * 0.95, `Production Core heap is above 95% of its limit: ${heapUsed}/${heapLimit}.`);
assert.ok(Number(memory?.registries?.mcpSessions || 0) <= 40, "Production MCP sessions exceeded the hard cap.");
assert.ok(Number(memory?.registries?.mcpEventStreams || 0) <= Number(memory?.registries?.mcpMaxEventStreams || 40), "Production SSE streams exceeded the hard cap.");
assert.ok(Number(memory?.registries?.processSessions || 0) === 0, "Unexpected retained process sessions during final acceptance.");

assert.equal(autoCompact.enabled, true);
assert.equal(autoCompact.running, true);
assert.equal(Number(autoCompact.thresholdPercent), 90);
assert.equal(autoCompact.authority, "classic-native-protocol");
assert.equal(Number(autoCompact.automaticPageActions || 0), 0);
assert.equal(Number(autoCompact.automatedReloads || 0), 0);
assert.equal(Number(autoCompact.syntheticVisibleUserMessages || 0), 0);

const goals = new GoalRuntime({ stateDir: config.stateDir });
const plans = new PlanRuntime({ stateDir: config.stateDir });
try {
  const goal = (await goals.activeGoals({ limit: 100 })).find((item) => item.id === goalId);
  assert.ok(goal, `Active Goal ${goalId} was not found.`);
  assert.equal(goal.status, "active");
  assert.ok(goal.round >= 9 && goal.roundState === "working", `Expected active Round 9+, observed ${goal.round}/${goal.roundState}.`);
  assert.equal(typeof goal.conversationId, "string", "Goal native conversation binding is missing.");
  assert.ok(goal.conversationId.length > 10, "Goal native conversation ID is invalid.");

  const boundPlans = (await activePlans(plans)).filter((item) => item.status === "active" && item.conversationId === goal.conversationId);
  assert.equal(boundPlans.length, 1, `Expected exactly one active Plan bound to Goal conversation, observed ${boundPlans.length}.`);
  const plan = boundPlans[0];

  const authority = new ClassicExactUsageAuthority({
    statePath: join(config.stateDir, "classic-native-usage-evidence.json"),
    maxAgeMs: 2 * 60 * 60_000,
  });
  const exact = await authority.status({ conversationId: goal.conversationId });
  assert.equal(exact.available, true, `Exact native usage unavailable: ${exact.reason}.`);
  assert.equal(exact.source, "classic-native-protocol");
  assert.ok(Number.isInteger(exact.exactUsedTokens) && exact.exactUsedTokens >= 0);
  assert.doesNotMatch(exact.evidencePath || "", /estimate|ledger|dom|context_window|remaining|max_tokens/i);

  const compactState = JSON.parse((await readFile(join(config.stateDir, "classic-native-auto-compact.json"), "utf8")).replace(/^\uFEFF/, ""));
  const accepted = (compactState.history || []).find((item) => item.state === "accepted" && item.conversationId === goal.conversationId);
  assert.ok(accepted, "No accepted same-conversation native compact record matches the Goal conversation.");
  assert.ok(Number(accepted.exactUsedTokensAfter) < Number(accepted.exactUsedTokensBefore), "Exact native usage did not fall after compact.");
  assert.equal(Number(accepted.automaticPageActions || 0), 0);
  assert.equal(Number(accepted.automatedReloads || 0), 0);
  assert.equal(Number(accepted.syntheticVisibleUserMessages || 0), 0);

  const logs = await logStats(join(configDir, "logs"));
  assert.ok(logs.largestBytes <= 16 * MIB, `A diagnostic log exceeds 16 MiB: ${logs.largestBytes}.`);
  assert.ok(logs.bytes <= 256 * MIB, `Diagnostic logs exceed the 256 MiB root quota: ${logs.bytes}.`);
  assert.ok(logs.files <= 256, `Diagnostic log count exceeds 256: ${logs.files}.`);

  console.log(JSON.stringify({
    ok: true,
    gate: "v0.5-final-live-acceptance",
    goal: {
      id: goal.id,
      round: goal.round,
      revision: goal.revision,
      conversationId: goal.conversationId,
    },
    plan: {
      id: plan.id,
      revision: plan.revision,
      activeSteps: (plan.steps || []).filter((step) => step.status === "in_progress").map((step) => step.id),
    },
    production: {
      gatewayPort,
      corePid: memory.pid,
      heapUsedMiB: Math.round((heapUsed / MIB) * 10) / 10,
      heapLimitMiB: Math.round((heapLimit / MIB) * 10) / 10,
      sessions: Number(memory?.registries?.mcpSessions || 0),
      activeRequests: Number(memory?.registries?.mcpActiveRequests || 0),
      eventStreams: Number(memory?.registries?.mcpEventStreams || 0),
    },
    exactUsage: {
      usedTokens: exact.exactUsedTokens,
      usageKind: exact.usageKind,
      observedAt: exact.observedAt,
      source: exact.source,
    },
    compact: {
      acceptedAt: accepted.acceptedAt,
      exactUsedTokensBefore: accepted.exactUsedTokensBefore,
      exactUsedTokensAfter: accepted.exactUsedTokensAfter,
      reductionTokens: accepted.reductionTokens,
      sameConversation: true,
      automaticPageActions: 0,
      automatedReloads: 0,
      syntheticVisibleUserMessages: 0,
    },
    logs: {
      files: logs.files,
      totalMiB: Math.round((logs.bytes / MIB) * 10) / 10,
      largestMiB: Math.round((logs.largestBytes / MIB) * 10) / 10,
    },
    fullProfile: {
      hostOverlay: true,
      contextGuardian: true,
      streamRecovery: true,
      autoCompact: true,
      thresholdPercent: 90,
    },
    executionPolicy: coreHealth.executionPolicy,
    secretValuesLogged: false,
  }));
} finally {
  await goals.close();
  await plans.close();
}
