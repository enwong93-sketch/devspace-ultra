/** Lossless acknowledgement projection. Full status and persistent history
 * remain unchanged; omit only an exact duplicate of lastRoundReport.
 */
export function goalAcknowledgementView(goal) {
  if (!goal?.lastRoundReport || !Array.isArray(goal.recentReports)) return { goal, omittedDuplicateReports: 0 };
  const fingerprint = JSON.stringify(goal.lastRoundReport);
  const recentReports = goal.recentReports.filter(report => JSON.stringify(report) !== fingerprint);
  const omittedDuplicateReports = goal.recentReports.length - recentReports.length;
  return { goal: omittedDuplicateReports ? { ...goal, recentReports } : goal, omittedDuplicateReports };
}
