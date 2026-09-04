#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createCodexContextBridge } from "../dist/codex-context-bridge.js";
import { loadConfig } from "../dist/config.js";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

function shortHash(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

function isCodingWorkspace(pathname) {
  const value = String(pathname || "").replaceAll("/", "\\").toLowerCase();
  return value.includes("\\documents\\codex\\") || value.includes("\\documents\\arpg") || value.includes("\\documents\\live2d");
}

async function rolloutHasCompaction(filePath, maxBytes = 96 * 1024 * 1024) {
  if (!filePath || !existsSync(filePath)) return false;
  const size = statSync(filePath).size;
  if (size <= 0 || size > maxBytes) return false;
  const lines = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"compacted"')) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type === "compacted" && typeof record?.payload?.message === "string") {
        lines.close();
        return true;
      }
    } catch {}
  }
  return false;
}

const config = loadConfig();
const codexDir = config.agentDir || join(homedir(), ".codex");
const tempStateDir = mkdtempSync(join(tmpdir(), "devspace-codex-context-live-"));
const bridge = createCodexContextBridge({ codexDir, stateDir: tempStateDir });

try {
  const explicitThreadId = arg("thread");
  let selected = null;
  let selectedInternal = null;
  let selectedHasCompaction = false;

  if (explicitThreadId) {
    const resolved = bridge.resolveThread({ threadId: explicitThreadId, includeArchived: true });
    if (!resolved.ok) throw new Error(`Requested Codex thread was not found: ${explicitThreadId}`);
    selected = resolved.thread;
    selectedInternal = resolved.internal;
    selectedHasCompaction = await rolloutHasCompaction(selectedInternal.rollout_path);
  } else {
    const candidates = bridge.listThreads({ includeArchived: true, limit: 200 })
      .filter((thread) => isCodingWorkspace(thread.workspaceRoot));
    if (candidates.length === 0) throw new Error("No suitable local Codex coding/research thread was found for the live gate.");

    // Prefer a real compacted thread of manageable size so the gate verifies
    // the exact continuity feature without ever loading a giant rollout at once.
    for (const candidate of candidates) {
      const resolved = bridge.resolveThread({ threadId: candidate.id, includeArchived: true });
      if (!resolved.ok) continue;
      const filePath = resolved.internal.rollout_path;
      if (!filePath || !existsSync(filePath)) continue;
      const size = statSync(filePath).size;
      if (size <= 0 || size > 96 * 1024 * 1024) continue;
      if (await rolloutHasCompaction(filePath)) {
        selected = resolved.thread;
        selectedInternal = resolved.internal;
        selectedHasCompaction = true;
        break;
      }
    }

    if (!selected) {
      for (const candidate of candidates) {
        const resolved = bridge.resolveThread({ threadId: candidate.id, includeArchived: true });
        if (!resolved.ok) continue;
        const filePath = resolved.internal.rollout_path;
        if (!filePath || !existsSync(filePath)) continue;
        const size = statSync(filePath).size;
        if (size > 0 && size <= 48 * 1024 * 1024) {
          selected = resolved.thread;
          selectedInternal = resolved.internal;
          break;
        }
      }
    }
  }

  if (!selected || !selectedInternal) throw new Error("No bounded real Codex thread was eligible for ContextBridge live import.");

  const listed = bridge.listThreads({ query: selected.id, includeArchived: true, limit: 10 });
  if (!listed.some((thread) => thread.id === selected.id)) throw new Error("ContextBridge selector could not round-trip the chosen live Codex thread.");

  const imported = await bridge.importThread({
    threadId: selected.id,
    includeArchived: true,
    maxChars: 80_000,
    maxMessages: 60,
    maxMessageChars: 10_000,
    persist: true,
  });
  if (!imported.ok) throw new Error(`Live Codex import failed: ${imported.reason || "unknown"}`);
  if (imported.hiddenReasoningImported || imported.developerMessagesImported || imported.rawToolOutputImported) {
    throw new Error("Live ContextBridge import violated the excluded-hidden-content gate.");
  }
  if (!imported.contextText.includes("[Imported Codex Context")) throw new Error("Imported capsule is missing the historical-context boundary label.");
  if (imported.contextText.length > 81_000) throw new Error("Imported live capsule exceeded the configured bounded output budget.");

  const reopened = bridge.readCapsule({ capsuleId: imported.capsuleId, threadId: imported.threadId });
  if (!reopened.ok || reopened.contextText !== imported.contextText) throw new Error("Persisted sanitized capsule did not round-trip exactly.");

  console.log(JSON.stringify({
    ok: true,
    gate: "codex-context-bridge-live",
    threadIdPrefix: String(imported.threadId).slice(0, 12),
    titleLength: String(imported.title || "").length,
    workspacePresent: Boolean(imported.workspaceRoot),
    rolloutBytes: statSync(selectedInternal.rollout_path).size,
    sourceMode: imported.sourceMode,
    selectedRolloutHadCompaction: selectedHasCompaction,
    usedCodexCompaction: Boolean(imported.usedCodexCompaction),
    recordsScanned: imported.recordsScanned,
    messagesIncluded: imported.messagesIncluded,
    messagesOmitted: imported.messagesOmitted,
    redactionsApplied: imported.redactionsApplied,
    truncated: Boolean(imported.truncated),
    capsuleRoundTrip: true,
    contextHashPrefix: shortHash(imported.contextText),
    hiddenReasoningImported: false,
    developerMessagesImported: false,
    rawToolOutputImported: false,
    secretValuesLogged: false,
  }, null, 2));
} finally {
  bridge.close();
  rmSync(tempStateDir, { recursive: true, force: true });
}
