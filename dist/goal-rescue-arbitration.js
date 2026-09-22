const RESCUE_COMMITTED_STATES = new Set(['rescue-dispatched', 'rescue-submitted-unverified']);
const RESCUE_OWNED_STATES = new Set(['interrupted', 'restart-interrupted', 'completion-pending', 'uncertain']);

/** Pure policy: Goal recovery and interrupted-turn Rescue may never race. */
export function goalRecoveryRescueDecision(record) {
  if (RESCUE_COMMITTED_STATES.has(String(record?.turnState || ''))) {
    return { action: 'delegate', reason: 'ordinary-rescue-already-committed' };
  }
  if (record?.armed === true && RESCUE_OWNED_STATES.has(String(record?.turnState || ''))) {
    return { action: 'wait', reason: 'ordinary-rescue-owns-interrupted-round' };
  }
  return { action: 'hidden-recovery', reason: 'no-rescue-conflict' };
}
