const DEFAULT_TIMEOUT_MS = 30_000;

function positiveTimeout(value) {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive.");
  return timeoutMs;
}

export class StableGatewayAdmissionGate {
  constructor() {
    this.closed = false;
    this.activeRequests = 0;
    this.waiters = new Set();
    this.drainWaiters = new Set();
  }

  closeAdmission() {
    if (this.closed) return false;
    this.closed = true;
    return true;
  }

  openAdmission() {
    if (!this.closed) return false;
    this.closed = false;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter.resolve();
    return true;
  }

  async waitForOpen({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const boundedTimeout = positiveTimeout(timeoutMs);
    if (!this.closed) return;
    let waiter;
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (waiter) this.waiters.delete(waiter);
        rejectPromise(new Error(`Gateway admission timed out after ${boundedTimeout}ms.`));
      }, boundedTimeout);
      timer.unref?.();
      waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolvePromise();
        },
      };
      this.waiters.add(waiter);
    });
  }

  async enter({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    await this.waitForOpen({ timeoutMs });
    this.activeRequests += 1;
  }

  leave() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (this.activeRequests !== 0) return;
    const waiters = [...this.drainWaiters];
    this.drainWaiters.clear();
    for (const waiter of waiters) waiter.resolve();
  }

  async waitForDrain(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const boundedTimeout = positiveTimeout(timeoutMs);
    if (this.activeRequests === 0) return;
    let waiter;
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        if (waiter) this.drainWaiters.delete(waiter);
        rejectPromise(new Error(`Gateway HTTP drain timed out after ${boundedTimeout}ms.`));
      }, boundedTimeout);
      timer.unref?.();
      waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolvePromise();
        },
      };
      this.drainWaiters.add(waiter);
    });
  }

  snapshot() {
    return {
      closed: this.closed,
      activeRequests: this.activeRequests,
      queuedRequests: this.waiters.size,
    };
  }
}
