export class McpSessionRegistry {
    sessions = new Map();
    now;
    maxInactiveSessions;
    maxEventStreams;
    constructor(options = {}) {
        this.now = options.now ?? Date.now;
        this.maxInactiveSessions = options.maxInactiveSessions == null
            ? Number.POSITIVE_INFINITY
            : Math.max(0, Number(options.maxInactiveSessions) || 0);
        this.maxEventStreams = options.maxEventStreams == null
            ? Number.POSITIVE_INFINITY
            : Math.max(1, Number(options.maxEventStreams) || 1);
    }
    get size() {
        return this.sessions.size;
    }
    diagnostics() {
        const now = this.now();
        const entries = [...this.sessions.values()];
        const ages = entries.map((entry) => Math.max(0, now - Number(entry.lastActivityAt || now)));
        return {
            sessions: entries.length,
            activeRequests: entries.reduce((sum, entry) => sum + Number(entry.activeRequests || 0), 0),
            oldestActivityAgeMs: ages.length ? Math.max(...ages) : 0,
            newestActivityAgeMs: ages.length ? Math.min(...ages) : 0,
            eventStreams: entries.reduce((sum, entry) => sum + Number(entry.eventStreamRequests || 0), 0),
            eventStreamsClosing: entries.reduce((sum, entry) => sum + (entry.eventStreamClosing ? 1 : 0), 0),
            maxEventStreams: Number.isFinite(this.maxEventStreams) ? this.maxEventStreams : null,
        };
    }
    register(sessionId, transport) {
        this.sessions.set(sessionId, {
            transport,
            lastActivityAt: this.now(),
            activeRequests: 0,
            eventStreamRequests: 0,
            eventStreamStartedAt: null,
            eventStreamClosing: false,
        });
        this.#enforceInactiveCap();
    }
    get(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return undefined;
        entry.lastActivityAt = this.now();
        return entry.transport;
    }
    acquire(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return undefined;
        entry.activeRequests += 1;
        entry.lastActivityAt = this.now();
        return entry.transport;
    }
    markEventStreamOpen(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return false;
        entry.eventStreamRequests = Math.max(0, Number(entry.eventStreamRequests || 0)) + 1;
        if (!entry.eventStreamStartedAt)
            entry.eventStreamStartedAt = this.now();
        entry.eventStreamClosing = false;
        entry.lastActivityAt = this.now();
        this.#enforceEventStreamCap();
        return true;
    }
    release(sessionId, { eventStream = false } = {}) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return false;
        entry.activeRequests = Math.max(0, Number(entry.activeRequests || 0) - 1);
        if (eventStream) {
            entry.eventStreamRequests = Math.max(0, Number(entry.eventStreamRequests || 0) - 1);
            if (entry.eventStreamRequests === 0) {
                entry.eventStreamStartedAt = null;
                entry.eventStreamClosing = false;
            }
        }
        entry.lastActivityAt = this.now();
        return true;
    }
    remove(sessionId) {
        return this.sessions.delete(sessionId);
    }
    async closeIdle(idleTimeoutMs) {
        const cutoff = this.now() - idleTimeoutMs;
        const idleSessions = [];
        for (const [sessionId, entry] of this.sessions) {
            if (entry.activeRequests > 0 || entry.lastActivityAt > cutoff)
                continue;
            this.sessions.delete(sessionId);
            idleSessions.push({ sessionId, transport: entry.transport });
        }
        return closeSessions(idleSessions);
    }
    async closeExcessInactive(maxInactiveSessions) {
        const maxInactive = Math.max(0, Number(maxInactiveSessions) || 0);
        const inactive = Array.from(this.sessions, ([sessionId, entry]) => ({ sessionId, entry }))
            .filter(({ entry }) => Number(entry.activeRequests || 0) === 0)
            .sort((a, b) => Number(a.entry.lastActivityAt || 0) - Number(b.entry.lastActivityAt || 0));
        const excess = inactive.slice(0, Math.max(0, inactive.length - maxInactive));
        const sessions = [];
        for (const { sessionId, entry } of excess) {
            if (!this.sessions.delete(sessionId))
                continue;
            sessions.push({ sessionId, transport: entry.transport });
        }
        return closeSessions(sessions);
    }
    async closeAll() {
        const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({
            sessionId,
            transport: entry.transport,
        }));
        this.sessions.clear();
        return closeSessions(sessions);
    }
    #enforceEventStreamCap() {
        if (!Number.isFinite(this.maxEventStreams))
            return;
        let activeStreams = [...this.sessions.values()].reduce((sum, entry) => (
            sum + (entry.eventStreamClosing ? 0 : Number(entry.eventStreamRequests || 0))
        ), 0);
        if (activeStreams <= this.maxEventStreams)
            return;
        const oldest = Array.from(this.sessions, ([sessionId, entry]) => ({ sessionId, entry }))
            .filter(({ entry }) => Number(entry.eventStreamRequests || 0) > 0 && entry.eventStreamClosing !== true)
            .sort((a, b) => Number(a.entry.eventStreamStartedAt || 0) - Number(b.entry.eventStreamStartedAt || 0));
        for (const { entry } of oldest) {
            if (activeStreams <= this.maxEventStreams)
                break;
            if (typeof entry.transport?.closeStandaloneSSEStream !== "function")
                continue;
            entry.eventStreamClosing = true;
            try {
                entry.transport.closeStandaloneSSEStream();
                activeStreams -= Math.max(1, Number(entry.eventStreamRequests || 1));
            }
            catch {
                entry.eventStreamClosing = false;
            }
        }
    }
    #enforceInactiveCap() {
        if (!Number.isFinite(this.maxInactiveSessions))
            return;
        const inactive = Array.from(this.sessions, ([sessionId, entry]) => ({ sessionId, entry }))
            .filter(({ entry }) => Number(entry.activeRequests || 0) === 0)
            .sort((a, b) => Number(a.entry.lastActivityAt || 0) - Number(b.entry.lastActivityAt || 0));
        const excess = inactive.slice(0, Math.max(0, inactive.length - this.maxInactiveSessions));
        if (!excess.length)
            return;
        const sessions = [];
        for (const { sessionId, entry } of excess) {
            if (!this.sessions.delete(sessionId))
                continue;
            sessions.push({ sessionId, transport: entry.transport });
        }
        void closeSessions(sessions);
    }
}
async function closeSessions(sessions) {
    return Promise.all(sessions.map(async ({ sessionId, transport }) => {
        try {
            await transport.close();
            return { sessionId };
        }
        catch (error) {
            return { sessionId, error };
        }
    }));
}
