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

  async waitForOpen({ signal } = {}) {
    if (!this.closed) return signal?.aborted !== true;
    if (signal?.aborted) return false;
    return await new Promise((resolvePromise) => {
      let settled = false;
      let waiter;
      const finish = (opened) => {
        if (settled) return;
        settled = true;
        if (waiter) this.waiters.delete(waiter);
        signal?.removeEventListener?.("abort", onAbort);
        resolvePromise(opened);
      };
      const onAbort = () => finish(false);
      waiter = { resolve: () => finish(true) };
      this.waiters.add(waiter);
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (!this.closed) finish(true);
    });
  }

  async enter(options = {}) {
    const opened = await this.waitForOpen(options);
    if (!opened || options.signal?.aborted) return false;
    this.activeRequests += 1;
    return true;
  }

  leave() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (this.activeRequests !== 0) return;
    const waiters = [...this.drainWaiters];
    this.drainWaiters.clear();
    for (const waiter of waiters) waiter.resolve();
  }

  async waitForDrain(_options = {}) {
    if (this.activeRequests === 0) return;
    await new Promise((resolvePromise) => {
      this.drainWaiters.add({ resolve: resolvePromise });
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
