import { copyFile, readFile } from "node:fs/promises";
import { atomicWriteJson } from "./atomic-file.js";

const STATE_VERSION = 1;
const AGENT_PROGRESS_SOURCE = "agent-progress-tool";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function isAgentAuthoredProgressMessage(value) {
  const message = asObject(value);
  return message.source === AGENT_PROGRESS_SOURCE || message.agentAuthored === true;
}

export function filterAgentAuthoredProgressState(value) {
  const state = asObject(value);
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const retained = messages.filter(isAgentAuthoredProgressMessage);
  return {
    state: {
      ...state,
      messages: retained,
      visibleNarrationPolicy: "agent-authored-only",
      automaticVisibleNarration: false,
    },
    originalCount: messages.length,
    retainedCount: retained.length,
    removedCount: messages.length - retained.length,
  };
}

export async function migrateAgentAuthoredProgressState(statePath) {
  const path = String(statePath || "").trim();
  if (!path) throw new Error("Progress state path is required.");
  let parsed = null;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: true,
        statePath: path,
        stateVersion: STATE_VERSION,
        originalCount: 0,
        retainedCount: 0,
        removedCount: 0,
        migrated: false,
        reason: "missing-state",
      };
    }
    throw error;
  }

  const filtered = filterAgentAuthoredProgressState(parsed);
  const alreadyMarked = parsed?.visibleNarrationPolicy === "agent-authored-only"
    && parsed?.automaticVisibleNarration === false;
  if (filtered.removedCount === 0 && alreadyMarked) {
    return {
      ok: true,
      statePath: path,
      stateVersion: STATE_VERSION,
      ...filtered,
      migrated: false,
      reason: "already-agent-authored-only",
    };
  }

  const backupPath = `${path}.legacy-visible-narration.bak`;
  try { await copyFile(path, backupPath); } catch {}
  await atomicWriteJson(path, filtered.state);
  return {
    ok: true,
    statePath: path,
    backupPath,
    stateVersion: STATE_VERSION,
    originalCount: filtered.originalCount,
    retainedCount: filtered.retainedCount,
    removedCount: filtered.removedCount,
    migrated: true,
    reason: "legacy-synthetic-progress-removed",
  };
}

export const agentAuthoredProgressStateInternals = {
  STATE_VERSION,
  AGENT_PROGRESS_SOURCE,
  asObject,
};
