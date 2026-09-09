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

  async waitForOpen(_options = {}) {
    if (!this.closed) return;
    await new Promise((resolvePromise) => {
      const waiter = { resolve: resolvePromise };
      this.waiters.add(waiter);
    });
  }

  async enter(options = {}) {
    await this.waitForOpen(options);
    this.activeRequests += 1;
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
