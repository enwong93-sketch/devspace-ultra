import { createHash, randomBytes } from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function normalizeId(value, label) {
  const text = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function tokenHash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function normalizeOwner(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("ownerConversationId is required for a conversation-isolated MCP connection.");
  return text.slice(0, 300);
}

function ownerKey(value) {
  return createHash("sha256").update(normalizeOwner(value)).digest("hex").slice(0, 32);
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error ?? "Unknown connection error");
}

function clonePublicConnection(row) {
  return {
    key: row.key,
    pluginId: row.pluginId,
    serverId: row.serverId,
    scope: row.scope,
    isolationKind: row.isolationKind ?? null,
    instanceId: row.instanceId ?? null,
    runtimeId: row.runtimeId ?? null,
    ownerConversationId: row.ownerConversationId ?? null,
    ownerLabel: row.ownerLabel ?? null,
    state: row.state,
    connecting: row.connecting === true,
    connectedAt: row.connectedAt ?? null,
    lastUsedAt: row.lastUsedAt ?? null,
    disconnectedAt: row.disconnectedAt ?? null,
    reconnectCount: Number(row.reconnectCount || 0),
    lastError: row.lastError ?? null,
  };
}

/**
 * One connection authority for every capability MCP transport.
 *
 * Every MCP transport is conversation-isolated. A stateless backend process
 * may still be reused by its own implementation, but DevSpace never reuses one
 * MCP client/session object across ChatGPT conversations. Stateful application
 * servers are additionally isolated by plugin/server/instance/runtime.
 * The manager never applies a lease, TTL, count limit, or wall-clock deadline.
 */
export class CapabilityConnectionManager {
  constructor({ now = nowIso } = {}) {
    this.now = now;
    this.clients = new Map();
    this.connecting = new Map();
    this.startupTails = new Map();
    this.instances = new Map();
    this.connectionStates = new Map();
  }

  connectionKey(pluginId, serverId, instanceId = null, {
    ownerConversationId = null,
  } = {}) {
    const plugin = normalizeId(pluginId, "pluginId");
    const server = normalizeId(serverId, "serverId");
    if (instanceId) return `${plugin}::${server}::instance:${normalizeId(instanceId, "instanceId")}`;
    return `${plugin}::${server}::conversation:${ownerKey(ownerConversationId)}`;
  }

  instanceKey(pluginId, serverId, instanceId) {
    return `${normalizeId(pluginId, "pluginId")}::${normalizeId(serverId, "serverId")}::${normalizeId(instanceId, "instanceId")}`;
  }

  publicInstance(instance) {
    return {
      pluginId: instance.pluginId,
      serverId: instance.serverId,
      instanceId: instance.instanceId,
      runtimeId: instance.runtimeId ?? null,
      ownerLabel: instance.ownerLabel,
      ownerConversationId: instance.ownerConversationId ?? null,
      createdAt: instance.createdAt,
      lastUsedAt: instance.lastUsedAt,
      expiresAt: null,
      envNames: Object.keys(instance.envOverrides || {}).sort(),
    };
  }

  claimInstance({
    pluginId,
    serverId,
    instanceId,
    runtimeId = null,
    ownerLabel = "agent",
    ownerConversationId = null,
    envOverrides = {},
  } = {}) {
    const plugin = normalizeId(pluginId, "pluginId");
    const server = normalizeId(serverId, "serverId");
    const instance = normalizeId(instanceId, "instanceId");
    const key = this.instanceKey(plugin, server, instance);
    const existing = this.instances.get(key);
    if (existing) {
      const sameOwner = !existing.ownerConversationId
        || !ownerConversationId
        || existing.ownerConversationId === ownerConversationId;
      if (!sameOwner) throw new Error(`Capability MCP instance ${instance} belongs to another conversation.`);
      throw new Error(`Capability MCP instance ${instance} is already claimed.`);
    }
    const issuedToken = randomBytes(32).toString("base64url");
    const timestamp = this.now();
    const row = {
      pluginId: plugin,
      serverId: server,
      instanceId: instance,
      runtimeId: runtimeId ? normalizeId(runtimeId, "runtimeId") : null,
      token: issuedToken,
      tokenHash: tokenHash(issuedToken),
      ownerLabel: String(ownerLabel || "agent").trim().slice(0, 120) || "agent",
      ownerConversationId: String(ownerConversationId || "").trim() || null,
      envOverrides: { ...envOverrides },
      createdAt: timestamp,
      lastUsedAt: timestamp,
    };
    this.instances.set(key, row);
    return {
      ok: true,
      instanceToken: issuedToken,
      instance: this.publicInstance(row),
    };
  }

  findInstanceByToken(instanceToken) {
    const digest = tokenHash(instanceToken);
    for (const instance of this.instances.values()) {
      if (instance.tokenHash === digest) return instance;
    }
    throw new Error("Invalid capability instance token.");
  }

  resolveInstance(instanceToken, { pluginId, serverId, ownerConversationId } = {}) {
    const instance = this.findInstanceByToken(instanceToken);
    if (pluginId && instance.pluginId !== normalizeId(pluginId, "pluginId")) {
      throw new Error("Capability instance token belongs to a different plugin.");
    }
    if (serverId && instance.serverId !== normalizeId(serverId, "serverId")) {
      throw new Error("Capability instance token belongs to a different MCP server.");
    }
    const owner = String(ownerConversationId || "").trim();
    if (owner && instance.ownerConversationId && owner !== instance.ownerConversationId) {
      throw new Error("Capability instance token belongs to another conversation.");
    }
    instance.lastUsedAt = this.now();
    return instance;
  }

  findInstanceByRuntime(runtimeId, { pluginId, serverId, ownerConversationId } = {}) {
    const normalizedRuntime = normalizeId(runtimeId, "runtimeId");
    const matches = [...this.instances.values()].filter((instance) => (
      instance.runtimeId === normalizedRuntime
      && (!pluginId || instance.pluginId === normalizeId(pluginId, "pluginId"))
      && (!serverId || instance.serverId === normalizeId(serverId, "serverId"))
    ));
    if (matches.length !== 1) {
      if (!matches.length) throw new Error(`No capability connection is bound to runtime ${normalizedRuntime}.`);
      throw new Error(`Runtime ${normalizedRuntime} is ambiguously bound to multiple capability connections.`);
    }
    const instance = matches[0];
    const owner = String(ownerConversationId || "").trim();
    if (owner && instance.ownerConversationId && owner !== instance.ownerConversationId) {
      throw new Error(`Runtime ${normalizedRuntime} belongs to another conversation.`);
    }
    instance.lastUsedAt = this.now();
    return instance;
  }

  tokenForRuntime(runtimeId, options = {}) {
    return this.findInstanceByRuntime(runtimeId, options).token;
  }

  listInstances({ pluginId, serverId, ownerConversationId } = {}) {
    const owner = String(ownerConversationId || "").trim();
    return [...this.instances.values()]
      .filter((item) => (
        (!pluginId || item.pluginId === normalizeId(pluginId, "pluginId"))
        && (!serverId || item.serverId === normalizeId(serverId, "serverId"))
        && (!owner || !item.ownerConversationId || item.ownerConversationId === owner)
      ))
      .map((item) => this.publicInstance(item))
      .sort((a, b) => `${a.pluginId}/${a.serverId}/${a.instanceId}`.localeCompare(`${b.pluginId}/${b.serverId}/${b.instanceId}`));
  }

  async serializeStartup(pluginId, serverId, operation) {
    const key = `${normalizeId(pluginId, "pluginId")}::${normalizeId(serverId, "serverId")}`;
    const previous = this.startupTails.get(key) || Promise.resolve();
    let release;
    const tail = new Promise((resolve) => { release = resolve; });
    this.startupTails.set(key, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.startupTails.get(key) === tail) this.startupTails.delete(key);
    }
  }

  async getOrConnect({
    pluginId,
    serverId,
    instance = null,
    ownerConversationId = null,
    connect,
  }) {
    if (typeof connect !== "function") throw new Error("connect is required.");
    const owner = instance
      ? normalizeOwner(instance.ownerConversationId)
      : normalizeOwner(ownerConversationId);
    const key = this.connectionKey(pluginId, serverId, instance?.instanceId, {
      ownerConversationId: owner,
    });
    const existing = this.clients.get(key);
    if (existing) {
      const state = this.connectionStates.get(key);
      if (state) {
        state.lastUsedAt = this.now();
        state.state = "ready";
      }
      return existing;
    }
    let pending = this.connecting.get(key);
    if (!pending) {
      const previousState = this.connectionStates.get(key);
      const state = {
        key,
        pluginId: normalizeId(pluginId, "pluginId"),
        serverId: normalizeId(serverId, "serverId"),
        scope: instance ? "runtime-isolated" : "conversation-isolated",
        isolationKind: instance ? "runtime" : "conversation",
        instanceId: instance?.instanceId ?? null,
        runtimeId: instance?.runtimeId ?? null,
        ownerConversationId: instance?.ownerConversationId ?? owner ?? null,
        ownerLabel: instance?.ownerLabel ?? null,
        state: "connecting",
        connecting: true,
        connectedAt: previousState?.connectedAt ?? null,
        lastUsedAt: this.now(),
        disconnectedAt: previousState?.disconnectedAt ?? null,
        reconnectCount: Number(previousState?.reconnectCount || 0),
        lastError: null,
      };
      this.connectionStates.set(key, state);
      pending = this.serializeStartup(pluginId, serverId, async () => {
        try {
          const holder = await connect();
          this.clients.set(key, holder);
          state.state = "ready";
          state.connecting = false;
          state.connectedAt = this.now();
          state.lastUsedAt = state.connectedAt;
          state.lastError = null;
          return holder;
        } catch (error) {
          state.state = "failed";
          state.connecting = false;
          state.lastError = safeError(error);
          state.disconnectedAt = this.now();
          state.reconnectCount += 1;
          throw error;
        }
      }).finally(() => this.connecting.delete(key));
      this.connecting.set(key, pending);
    }
    return await pending;
  }

  async invalidate({
    pluginId,
    serverId,
    instanceId = null,
    ownerConversationId = null,
    closeHolder,
    reason = "transport-disconnected",
  } = {}) {
    const key = this.connectionKey(pluginId, serverId, instanceId, {
      ownerConversationId,
    });
    const pending = this.connecting.get(key);
    if (pending) {
      try { await pending; } catch {}
    }
    const holder = this.clients.get(key);
    this.clients.delete(key);
    const state = this.connectionStates.get(key);
    if (state) {
      state.state = "disconnected";
      state.connecting = false;
      state.disconnectedAt = this.now();
      state.lastError = String(reason || "transport-disconnected").slice(0, 500);
      state.reconnectCount += 1;
    }
    if (holder && typeof closeHolder === "function") await closeHolder(holder);
    return Boolean(holder);
  }

  async releaseInstance(instanceToken, { closeHolder } = {}) {
    const instance = this.findInstanceByToken(instanceToken);
    const key = this.instanceKey(instance.pluginId, instance.serverId, instance.instanceId);
    this.instances.delete(key);
    await this.invalidate({
      pluginId: instance.pluginId,
      serverId: instance.serverId,
      instanceId: instance.instanceId,
      closeHolder,
      reason: "explicit-release",
    });
    this.connectionStates.delete(this.connectionKey(instance.pluginId, instance.serverId, instance.instanceId));
    return { ok: true, released: true, instance: this.publicInstance(instance) };
  }

  /**
   * Convert a legacy backend-wide holder into one owned runtime connection
   * without closing the MCP client. This is used only during migration of an
   * already-running application such as Blender: the application process and
   * current scene remain untouched while future calls become owner-scoped.
   */
  async adoptLegacySharedConnection({ pluginId, serverId, instance } = {}) {
    if (!instance?.instanceId) throw new Error("instance is required for legacy connection adoption.");
    const plugin = normalizeId(pluginId, "pluginId");
    const server = normalizeId(serverId, "serverId");
    const targetKey = this.connectionKey(plugin, server, instance.instanceId);
    const legacyKeys = [
      `${plugin}::${server}`,
      `${plugin}::${server}::shared`,
    ];
    if (this.clients.has(targetKey)) return { adopted: false, reason: "target-already-connected", key: targetKey };
    for (const legacyKey of legacyKeys) {
      const pending = this.connecting.get(legacyKey);
      if (pending) {
        try { await pending; } catch {}
      }
      const holder = this.clients.get(legacyKey);
      if (!holder) continue;
      this.clients.delete(legacyKey);
      this.clients.set(targetKey, holder);
      const oldState = this.connectionStates.get(legacyKey);
      this.connectionStates.delete(legacyKey);
      this.connectionStates.set(targetKey, {
        ...(oldState || {}),
        key: targetKey,
        pluginId: plugin,
        serverId: server,
        scope: "runtime-isolated",
        isolationKind: "runtime",
        instanceId: instance.instanceId,
        runtimeId: instance.runtimeId ?? null,
        ownerConversationId: instance.ownerConversationId ?? null,
        ownerLabel: instance.ownerLabel ?? null,
        state: "ready",
        connecting: false,
        lastUsedAt: this.now(),
      });
      return { adopted: true, fromKey: legacyKey, key: targetKey };
    }
    return { adopted: false, reason: "legacy-holder-not-found", key: targetKey };
  }

  async closePlugin(pluginId, { closeHolder } = {}) {
    const normalized = normalizeId(pluginId, "pluginId");
    for (const [key, instance] of [...this.instances]) {
      if (instance.pluginId === normalized) this.instances.delete(key);
    }
    const connectionKeys = new Set([
      ...[...this.clients.keys()].filter((key) => key.startsWith(`${normalized}::`)),
      ...[...this.connecting.keys()].filter((key) => key.startsWith(`${normalized}::`)),
      ...[...this.connectionStates.keys()].filter((key) => key.startsWith(`${normalized}::`)),
    ]);
    for (const key of connectionKeys) {
      const holder = this.clients.get(key);
      this.clients.delete(key);
      if (holder && typeof closeHolder === "function") await closeHolder(holder);
      this.connectionStates.delete(key);
    }
  }

  async closeAll({ closeHolder } = {}) {
    for (const holder of [...this.clients.values()]) {
      if (typeof closeHolder === "function") await closeHolder(holder);
    }
    this.clients.clear();
    this.connecting.clear();
    this.startupTails.clear();
    this.instances.clear();
    this.connectionStates.clear();
  }

  listConnections({ pluginId, serverId, ownerConversationId } = {}) {
    const owner = String(ownerConversationId || "").trim();
    return [...this.connectionStates.values()]
      .filter((row) => (
        (!pluginId || row.pluginId === normalizeId(pluginId, "pluginId"))
        && (!serverId || row.serverId === normalizeId(serverId, "serverId"))
        && (!owner || row.ownerConversationId === owner)
      ))
      .map(clonePublicConnection)
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  diagnostics() {
    const states = [...this.connectionStates.values()];
    return {
      clients: this.clients.size,
      connecting: this.connecting.size,
      startupQueues: this.startupTails.size,
      instances: this.instances.size,
      sharedConnections: 0,
      isolatedConnections: states.length,
      conversationIsolatedConnections: states.filter((row) => row.scope === "conversation-isolated").length,
      runtimeIsolatedConnections: states.filter((row) => row.scope === "runtime-isolated").length,
      readyConnections: states.filter((row) => row.state === "ready").length,
      failedConnections: states.filter((row) => row.state === "failed").length,
      disconnectedConnections: states.filter((row) => row.state === "disconnected").length,
    };
  }
}
