let maintenanceGcScheduled = false;
function cleanClientSessionFingerprint(value) {
    const text = String(value ?? "").trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(text) ? text : null;
}
function scheduleMaintenanceGc() {
    if (maintenanceGcScheduled || typeof globalThis.gc !== "function")
        return;
    maintenanceGcScheduled = true;
    setImmediate(() => {
        maintenanceGcScheduled = false;
        try {
            globalThis.gc();
        }
        catch { }
    });
}

export class McpSessionRegistry {
    sessions = new Map();
    clientSessions = new Map();
    now;
    constructor(options = {}) {
        this.now = options.now ?? Date.now;
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
            clientSessions: this.clientSessions.size,
            identifiedSessions: entries.filter((entry) => Boolean(entry.clientSessionFingerprint)).length,
            unidentifiedSessions: entries.filter((entry) => !entry.clientSessionFingerprint).length,
            supersededSessions: entries.filter((entry) => entry.superseded === true).length,
            activeRequests: entries.reduce((sum, entry) => sum + Number(entry.activeRequests || 0), 0),
            oldestActivityAgeMs: ages.length ? Math.max(...ages) : 0,
            newestActivityAgeMs: ages.length ? Math.min(...ages) : 0,
            eventStreams: entries.reduce((sum, entry) => sum + Number(entry.eventStreamRequests || 0), 0),
            eventStreamsClosing: 0,
            maxEventStreams: null,
            maxSessions: null,
        };
    }
    register(sessionId, transport, { clientSessionFingerprint = null } = {}) {
        if (this.sessions.has(sessionId)) {
            void closeSessions([{ sessionId, transport }]);
            return false;
        }
        const fingerprint = cleanClientSessionFingerprint(clientSessionFingerprint);
        const entry = {
            transport,
            lastActivityAt: this.now(),
            activeRequests: 0,
            eventStreamRequests: 0,
            everHadEventStream: false,
            disconnectObserved: false,
            superseded: false,
            clientSessionFingerprint: fingerprint,
        };
        this.sessions.set(sessionId, entry);
        if (fingerprint) {
            const priorId = this.clientSessions.get(fingerprint);
            const prior = priorId && priorId !== sessionId ? this.sessions.get(priorId) : null;
            this.clientSessions.set(fingerprint, sessionId);
            if (prior) {
                prior.superseded = true;
                this.#closeRetiredIfIdle(priorId, prior);
            }
        }
        return true;
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
        entry.everHadEventStream = true;
        entry.disconnectObserved = false;
        entry.lastActivityAt = this.now();
        return true;
    }
    release(sessionId, { eventStream = false } = {}) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return false;
        entry.activeRequests = Math.max(0, Number(entry.activeRequests || 0) - 1);
        if (eventStream) {
            entry.eventStreamRequests = Math.max(0, Number(entry.eventStreamRequests || 0) - 1);
            if (entry.everHadEventStream && entry.eventStreamRequests === 0) {
                entry.disconnectObserved = true;
            }
        }
        entry.lastActivityAt = this.now();
        this.#closeRetiredIfIdle(sessionId, entry);
        return true;
    }
    remove(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry)
            return false;
        this.sessions.delete(sessionId);
        if (entry.clientSessionFingerprint && this.clientSessions.get(entry.clientSessionFingerprint) === sessionId) {
            this.clientSessions.delete(entry.clientSessionFingerprint);
        }
        return true;
    }
    async closeAll() {
        const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({
            sessionId,
            transport: entry.transport,
        }));
        this.sessions.clear();
        this.clientSessions.clear();
        return closeSessions(sessions);
    }
    #closeRetiredIfIdle(sessionId, entry) {
        if (entry.activeRequests > 0)
            return false;
        // A superseded transport's standalone SSE is not substantive tool work.
        // Closing the transport is what terminates that obsolete stream; waiting
        // for the stream to close first creates a circular retention leak.
        if (!entry.superseded && (!entry.disconnectObserved || entry.eventStreamRequests > 0))
            return false;
        if (!this.remove(sessionId))
            return false;
        void closeSessions([{ sessionId, transport: entry.transport }]);
        return true;
    }
}
async function closeSessions(sessions) {
    const results = await Promise.all(sessions.map(async ({ sessionId, transport }) => {
        try {
            await transport.close();
            return { sessionId };
        }
        catch (error) {
            return { sessionId, error };
        }
    }));
    if (sessions.length)
        scheduleMaintenanceGc();
    return results;
}
