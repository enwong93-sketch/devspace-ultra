import { constants as osConstants, getPriority, setPriority } from "node:os";

const ROLE_TARGETS = Object.freeze({
  launcher: osConstants.priority.PRIORITY_NORMAL,
  gateway: osConstants.priority.PRIORITY_ABOVE_NORMAL,
  core: osConstants.priority.PRIORITY_NORMAL,
});

/**
 * Apply one bounded Windows scheduling priority to a DevSpace process.
 * Gateway is AboveNormal so health/admission/control work remains responsive
 * during CPU saturation. Core and launcher stay Normal; High/Realtime are
 * deliberately excluded. Priority failure is diagnostic and never fatal.
 */
export function applyDevspaceRuntimePriority(role, {
  pid = 0,
  platform = process.platform,
  getPriorityImpl = getPriority,
  setPriorityImpl = setPriority,
} = {}) {
  const target = ROLE_TARGETS[role];
  if (!Number.isInteger(target)) throw new Error(`Unknown DevSpace runtime priority role: ${role}`);
  if (platform !== "win32") {
    return { ok: true, applied: false, role, pid, target, reason: "non-windows" };
  }
  try {
    const before = getPriorityImpl(pid);
    if (before !== target) setPriorityImpl(pid, target);
    const after = getPriorityImpl(pid);
    return { ok: after === target, applied: before !== after, role, pid, target, before, after };
  } catch (error) {
    return {
      ok: false,
      applied: false,
      role,
      pid,
      target,
      errorName: error instanceof Error ? error.name : "Error",
    };
  }
}

export const devspaceRuntimePriorityTargets = ROLE_TARGETS;
