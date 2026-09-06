import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_STARTUP_REPAIR_WINDOW_MS = 60_000;
const DEFAULT_REPAIR_TIMEOUT_MS = 45_000;
const scriptPath = fileURLToPath(new URL("../scripts/chat-classic-primary-debug.ps1", import.meta.url));

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== "object") {
    return { running: false, pid: null, debugReady: false, startedAtMs: null };
  }
  const startedAtMs = typeof value.startedAtMs === "number"
    ? value.startedAtMs
    : value.startedAt
      ? Date.parse(String(value.startedAt))
      : null;
  return {
    running: value.running === true,
    pid: Number.isInteger(Number(value.pid)) && Number(value.pid) > 0 ? Number(value.pid) : null,
    debugReady: value.debugReady === true,
    visible: value.visible === true,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
  };
}

async function runPowerShell(action, { expectedPid, timeoutMs = DEFAULT_REPAIR_TIMEOUT_MS } = {}) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-Action", action,
  ];
  if (expectedPid) args.push("-ExpectedPid", String(expectedPid));
  const { stdout } = await execFileAsync("powershell.exe", args, {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  const text = String(stdout || "").trim();
  if (!text) throw new Error(`Primary debug ${action} returned no output.`);
  const line = text.split(/\r?\n/).filter(Boolean).at(-1);
  return JSON.parse(line);
}

export function createWindowsPrimaryDebugAdapter() {
  return {
    async snapshot() {
      const result = await runPowerShell("status", { timeoutMs: 10_000 });
      return normalizeSnapshot({
        running: result.Running,
        pid: result.Pid,
        debugReady: result.DebugReady,
        visible: result.Visible,
        startedAt: result.StartedAt,
      });
    },
    async repair({ expectedPid }) {
      const result = await runPowerShell("repair", { expectedPid });
      if (result.Ok !== true) {
        const error = new Error(result.Reason || "Canonical Main-01 debug repair failed.");
        error.definiteFailure = result.DefiniteFailure === true;
        throw error;
      }
      return {
        ok: true,
        pid: Number(result.Pid || result.PrimaryPidAfter || 0) || null,
        debugReady: result.DebugReady === true,
        visible: result.Visible === true,
      };
    },
  };
}

export class ClassicPrimaryDebugGuard {
  constructor({
    snapshot,
    repair,
    pollMs = DEFAULT_POLL_MS,
    startupRepairWindowMs = DEFAULT_STARTUP_REPAIR_WINDOW_MS,
    now = () => Date.now(),
  } = {}) {
    const adapter = (!snapshot || !repair) && process.platform === "win32"
      ? createWindowsPrimaryDebugAdapter()
      : null;
    this.snapshot = snapshot || adapter?.snapshot;
    this.repair = repair || adapter?.repair;
    if (typeof this.snapshot !== "function" || typeof this.repair !== "function") {
      throw new Error("ClassicPrimaryDebugGuard requires snapshot and repair adapters.");
    }
    this.pollMs = pollMs;
    this.startupRepairWindowMs = startupRepairWindowMs;
    this.now = now;
    this.timer = null;
    this.started = false;
    this.closed = false;
    this.polling = null;
    this.protectedPid = null;
    this.lastSeenPid = null;
    this.lastState = { state: "not-started" };
  }

  async start({ schedule = true } = {}) {
    if (this.started) return this.lastState;
    this.started = true;
    const snapshot = normalizeSnapshot(await this.snapshot());
    this.lastSeenPid = snapshot.pid;

    if (!snapshot.running || !snapshot.pid) {
      this.lastState = { state: "primary-absent", ...snapshot };
    } else if (snapshot.debugReady) {
      this.lastState = { state: "primary-debug-ready", ...snapshot };
    } else {
      const ageMs = snapshot.startedAtMs == null ? Number.POSITIVE_INFINITY : Math.max(0, this.now() - snapshot.startedAtMs);
      if (ageMs <= this.startupRepairWindowMs) {
        this.lastState = await this.#repairSnapshot(snapshot);
      } else {
        this.protectedPid = snapshot.pid;
        this.lastState = { state: "protected-existing-primary", protectedPid: snapshot.pid, ...snapshot };
      }
    }

    if (schedule && !this.closed && this.pollMs > 0) {
      this.timer = setInterval(() => { void this.pollOnce(); }, this.pollMs);
      this.timer.unref?.();
    }
    return this.lastState;
  }

  async pollOnce() {
    if (this.closed) return { state: "closed" };
    if (this.polling) return this.polling;
    this.polling = this.#pollOnceImpl().finally(() => { this.polling = null; });
    return this.polling;
  }

  async #pollOnceImpl() {
    let snapshot;
    try {
      snapshot = normalizeSnapshot(await this.snapshot());
    } catch (error) {
      this.lastState = { state: "snapshot-error", error: errorMessage(error) };
      return this.lastState;
    }

    if (!snapshot.running || !snapshot.pid) {
      this.lastSeenPid = null;
      this.protectedPid = null;
      this.lastState = { state: "primary-absent", ...snapshot };
      return this.lastState;
    }

    if (snapshot.debugReady) {
      this.lastSeenPid = snapshot.pid;
      if (this.protectedPid !== snapshot.pid) this.protectedPid = null;
      this.lastState = { state: "primary-debug-ready", ...snapshot };
      return this.lastState;
    }

    if (snapshot.pid === this.protectedPid) {
      this.lastSeenPid = snapshot.pid;
      this.lastState = { state: "protected-existing-primary", protectedPid: snapshot.pid, ...snapshot };
      return this.lastState;
    }

    const isNewPid = snapshot.pid !== this.lastSeenPid;
    this.lastSeenPid = snapshot.pid;
    if (isNewPid || this.protectedPid == null) {
      return this.#repairSnapshot(snapshot);
    }

    this.lastState = { state: "primary-debug-missing", ...snapshot };
    return this.lastState;
  }

  async #repairSnapshot(snapshot) {
    try {
      await this.repair({ expectedPid: snapshot.pid });
      const after = normalizeSnapshot(await this.snapshot());
      this.lastSeenPid = after.pid;
      if (after.running && after.pid && after.debugReady) {
        this.protectedPid = null;
        this.lastState = { state: "repaired-primary-debug", ...after };
        return this.lastState;
      }
      this.lastState = { state: "repair-incomplete", ...after };
      return this.lastState;
    } catch (error) {
      this.lastState = {
        state: "repair-error",
        pid: snapshot.pid,
        debugReady: false,
        error: errorMessage(error),
        definiteFailure: error?.definiteFailure === true,
      };
      return this.lastState;
    }
  }

  status() {
    return { ...this.lastState, protectedPid: this.protectedPid };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.polling) await this.polling.catch(() => {});
  }
}
