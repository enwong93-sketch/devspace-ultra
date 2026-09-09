const installed = new WeakSet();

/**
 * Preserve the instrumentation installation boundary without converting raw
 * tool traffic into user-visible narration. Goal/Plan state remains explicit,
 * and agents publish human-facing progress only through
 * devspace_progress_report in their own words at meaningful milestones.
 */
export function installGoalToolProgress(server, _options = {}) {
  if (!server || installed.has(server)) return false;
  installed.add(server);
  return true;
}
