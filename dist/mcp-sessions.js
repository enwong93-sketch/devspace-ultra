export class McpSessionRegistry {
    sessions = new Map();
    now;
    reservations = 0;
    constructor(options = {}) {
        this.now = options.now ?? Date.now;
        this.maxSessions = options.maxSessions ?? 256;
        if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1)
            throw new Error("maxSessions must be a positive integer");
    }
    get size() {
        return this.sessions.size;
    }
    register(sessionId, transport) {
        if (!this.sessions.has(sessionId) && this.sessions.size >= this.maxSessions)
            throw new Error("MCP session capacity exceeded");
        this.sessions.set(sessionId, {
            transport,
            lastActivityAt: this.now(),
            activeRequests: 0,
        });
    }
    // Reserve before awaiting transport creation/close so concurrent initializes
    // cannot exceed capacity. Only idle sessions may be evicted; active HTTP
    // requests (including SSE streams) are protected until finish or disconnect.
    async reserve() {
        let evicted;
        if (this.sessions.size + this.reservations >= this.maxSessions) {
            for (const [sessionId, entry] of this.sessions) {
                if (entry.activeRequests !== 0) continue;
                if (!evicted || entry.lastActivityAt < evicted.entry.lastActivityAt)
                    evicted = { sessionId, entry };
            }
            if (!evicted) return undefined;
            this.sessions.delete(evicted.sessionId);
        }
        this.reservations += 1;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            this.reservations -= 1;
        };
        try {
            if (evicted) await evicted.entry.transport.close();
            return { release, evictedSessionId: evicted?.sessionId };
        }
        catch (error) {
            release();
            throw error;
        }
    }
    beginRequest(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry) return () => {};
        entry.activeRequests += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            entry.activeRequests -= 1;
            entry.lastActivityAt = this.now();
        };
    }
    get(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return undefined;
        entry.lastActivityAt = this.now();
        return entry.transport;
    }
    remove(sessionId) {
        return this.sessions.delete(sessionId);
    }
    async closeIdle(idleTimeoutMs) {
        const cutoff = this.now() - idleTimeoutMs;
        const idleSessions = [];
        for (const [sessionId, entry] of this.sessions) {
            if (entry.activeRequests !== 0 || entry.lastActivityAt > cutoff)
                continue;
            this.sessions.delete(sessionId);
            idleSessions.push({ sessionId, transport: entry.transport });
        }
        return closeSessions(idleSessions);
    }
    async closeAll() {
        const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({
            sessionId,
            transport: entry.transport,
        }));
        this.sessions.clear();
        return closeSessions(sessions);
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
