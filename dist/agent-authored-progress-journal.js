/*
 * Production progress-journal boundary.
 *
 * Gateway, Core, Goal, Plan, and tool events are machine telemetry. They must
 * never be converted into user-visible prose. The floating narration card is
 * updated only through devspace_progress_report, whose message is written by
 * the active agent for the current conversation.
 */
export class GoalProgressNarrator {
  constructor(options = {}) {
    this.options = options;
    this.statePath = options?.progress?.statePath || options?.statePath || null;
    return new Proxy(this, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        if (typeof property === "symbol") return undefined;
        return async () => null;
      },
    });
  }

  async start() { return { ok: true, mode: "agent-authored-only" }; }
  async close() { return { ok: true }; }
  startToolCall() { return null; }
  finishToolCall() { return null; }
  noteSystem() { return null; }
  noteGoal() { return null; }
  notePlan() { return null; }
  snapshot() {
    return {
      ok: true,
      mode: "agent-authored-only",
      automaticVisibleNarration: false,
    };
  }
}
