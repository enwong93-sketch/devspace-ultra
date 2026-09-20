import { StableGatewaySessionRegistry } from "./stable-gateway-runtime.js";
import { createStableGatewayProxy } from "./stable-gateway-proxy.js";
import { StableGatewayAdmissionGate } from "./stable-gateway-admission.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CORE_RECOVERY_RETRY_MS = 2_000;

function normalizePublicBaseUrl(value) {
  const parsed = new URL(String(value ?? "").trim());
  if (parsed.protocol !== "https:") throw new Error("Stable Gateway publicBaseUrl must use https.");
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = "/";
  return parsed.toString().replace(/\/$/, "");
}

function requirePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${label} is invalid.`);
  return port;
}

function requireDependency(dependencies, name) {
  const value = dependencies?.[name];
  if (typeof value !== "function") throw new Error(`Stable Gateway dependency ${name} is required.`);
  return value;
}

function isReplayableMcpEventStream(req) {
  if (String(req?.method || "").toUpperCase() !== "GET") return false;
  let pathname = "";
  try { pathname = new URL(String(req?.url || "/"), "http://127.0.0.1").pathname; } catch {}
  // Streamable HTTP reserves GET /mcp for the replayable server-event stream.
  // Some ChatGPT hosts omit an explicit Accept header, so requiring it causes
  // the open stream to be counted forever as an ordinary draining request.
  return pathname === "/mcp";
}

function sendUnavailable(res, message) {
  if (res.headersSent) {
    res.destroy(new Error(message));
    return;
  }
  const body = Buffer.from(JSON.stringify({ ok: false, error: message }));
  res.statusCode = 503;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(body.length));
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

export function createStableGatewayController({
  publicBaseUrl,
  configDir,
  stateDir,
  corePorts,
  initialSlot = "a",
  initialCoreHandle,
  dependencies = {},
  activityJournal = null,
  registry = new StableGatewaySessionRegistry(),
  admission = new StableGatewayAdmissionGate(),
} = {}) {
  const publicBase = normalizePublicBaseUrl(publicBaseUrl);
  const configPath = String(configDir ?? "").trim();
  const statePath = String(stateDir ?? "").trim();
  if (!configPath) throw new Error("Stable Gateway configDir is required.");
  if (!statePath) throw new Error("Stable Gateway stateDir is required.");
  const ports = {
    a: requirePort(corePorts?.a, "corePorts.a"),
    b: requirePort(corePorts?.b, "corePorts.b"),
  };
  if (ports.a === ports.b) throw new Error("Core A and Core B ports must differ.");
  const requestedSlot = String(initialSlot).toLowerCase();
  if (!Object.hasOwn(ports, requestedSlot)) throw new Error("initialSlot must be a or b.");
  const startCoreSlot = requireDependency(dependencies, "startCoreSlot");
  const stopCoreSlot = requireDependency(dependencies, "stopCoreSlot");
  const createCandidateSnapshot = requireDependency(dependencies, "createCandidateSnapshot");
  const probeCandidate = requireDependency(dependencies, "probeCandidate");
  const readCoreSchemaFingerprint = requireDependency(dependencies, "readCoreSchemaFingerprint");
  // Core recovery/handover events remain machine diagnostics only. User-visible
  // progress is authored explicitly by the active agent through
  // devspace_progress_report, never synthesized from controller state. Keep the
  // structured activity journal for local liveness diagnostics and recovery tests.

  let activeSlot = requestedSlot;
  let activeHandle = initialCoreHandle ?? null;
  let proxy = null;
  let handoverInProgress = false;
  let fatalHandoverError = null;
  let fatalCoreRecoveryError = null;
  let coreRecoveryPromise = null;
  let deferredCoreExit = null;
  let closing = false;

  const slotId = (slot) => `core-${slot}`;
  const coreDescriptor = (handle) => ({ id: slotId(activeSlot) === handle.id ? handle.id : handle.id, baseUrl: handle.baseUrl });

  const startActive = (slot) => startCoreSlot({
    id: slotId(slot),
    port: ports[slot],
    configDir: configPath,
    stateDir: statePath,
    publicBaseUrl: publicBase,
    candidate: false,
  });

  const startCandidate = (slot, candidateStateDir) => startCoreSlot({
    id: slotId(slot),
    port: ports[slot],
    configDir: configPath,
    stateDir: candidateStateDir,
    publicBaseUrl: publicBase,
    candidate: true,
  });

  const ensureStopped = async (handle, label) => {
    const result = await stopCoreSlot(handle);
    if (result?.stopped !== true) throw new Error(`${label} did not stop safely.`);
  };

  const baselineSessionCandidates = () => {
    const sessions = registry.entriesForReplay();
    if (!sessions.length) throw new Error("Stable Gateway handover requires at least one live MCP session for continuity verification.");
    return sessions
      .map((entry, index) => ({
        entry,
        index,
        priority:
          (entry.initialized ? 16 : 0)
          + (entry.eventStreams > 0 ? 8 : 0)
          + (entry.activeRequests > 0 ? 4 : 0)
          + (entry.clientSessionFingerprint ? 2 : 0),
      }))
      .sort((left, right) => (
        right.priority - left.priority
        || Number(right.entry.lastActivityAt || 0) - Number(left.entry.lastActivityAt || 0)
        || left.index - right.index
      ))
      .map((item) => item.entry);
  };

  const resolveBaselineSchema = async (coreBaseUrl) => {
    const candidates = baselineSessionCandidates();
    const rejectedAuthorizations = [];
    for (const baseline of candidates.slice(0, 64)) {
      try {
        const schema = await readCoreSchemaFingerprint({
          coreBaseUrl,
          bearerToken: baseline.authorization,
        });
        return { baseline, schema };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/status\s+(?:401|403)\b/i.test(message)) throw error;
        rejectedAuthorizations.push({
          publicSessionId: baseline.publicSessionId,
          initialized: baseline.initialized === true,
          identified: Boolean(baseline.clientSessionFingerprint),
          activeRequests: Number(baseline.activeRequests || 0),
          eventStreams: Number(baseline.eventStreams || 0),
        });
      }
    }
    const error = new Error(`Stable Gateway handover could not find a currently authorized MCP session after ${rejectedAuthorizations.length} bounded schema probes.`);
    error.code = "STABLE_GATEWAY_AUTHORIZATION_UNAVAILABLE";
    error.rejectedSessions = rejectedAuthorizations;
    throw error;
  };

  const verifyCore = async (handle, baseline, expectedSchemaFingerprint, { allowSchemaChange = false } = {}) => {
    const result = await probeCandidate({
      coreBaseUrl: handle.baseUrl,
      publicBaseUrl: publicBase,
      bearerToken: baseline.authorization,
      expectedSchemaFingerprint,
      allowSchemaChange,
    });
    if (!result?.ok) throw new Error(`Core ${handle.id} compatibility gate failed at ${result?.stage ?? "unknown"}.`);
    return result;
  };

  const reopenAdmission = () => {
    registry.abortBarrier();
    admission.openAdmission();
  };

  const noteActivity = ({ title, detail = "", state = "completed" }) => {
    if (typeof activityJournal?.noteSystem !== "function") return;
    try { activityJournal.noteSystem({ title, detail, state }); } catch {}
  };

  const recoverActiveCore = ({ handle, slot, code, signal }) => {
    if (closing || handle !== activeHandle || slot !== activeSlot || !proxy) return coreRecoveryPromise;
    if (handoverInProgress) {
      deferredCoreExit = { handle, slot, code, signal };
      return coreRecoveryPromise;
    }
    if (coreRecoveryPromise) return coreRecoveryPromise;

    coreRecoveryPromise = (async () => {
      noteActivity({
        title: "Core recovery started",
        detail: `Core ${String(slot).toUpperCase()} PID ${handle?.pid ?? "unknown"} exited${code != null ? ` with code ${code}` : signal ? ` via ${signal}` : ""}.`,
        state: "running",
      });
      admission.closeAdmission();
      registry.beginBarrier();
      await Promise.all([
        admission.waitForDrain(),
        registry.waitForDrain(),
      ]);
      activeHandle = null;
      while (!closing) {
        let replacement = null;
        try {
          replacement = await startActive(slot);
          const replayed = await proxy.replaySessionsToCore({ id: slotId(slot), baseUrl: replacement.baseUrl });
          registry.commitMappings(replayed.mappings);
          proxy.setActiveCore({ id: slotId(slot), baseUrl: replacement.baseUrl });
          activeHandle = replacement;
          watchActiveHandle(replacement, slot);
          fatalCoreRecoveryError = null;
          noteActivity({
            title: "Core recovery completed",
            detail: `Core ${String(slot).toUpperCase()} restarted as PID ${replacement.pid ?? "unknown"}; replayed ${replayed.mappings.length}, deferred ${replayed.deferredPublicSessionIds.length}, removed ${replayed.droppedPublicSessionIds.length} incompatible session(s).`,
          });
          reopenAdmission();
          return {
            ok: true,
            activeSlot: slot,
            activePid: replacement.pid ?? null,
            replayedSessions: replayed.mappings.length,
            droppedSessions: replayed.droppedPublicSessionIds.length,
            deferredSessions: replayed.deferredPublicSessionIds.length,
            replayFailureReasons: replayed.failureReasonCounts,
          };
        } catch (error) {
          if (replacement) await stopCoreSlot(replacement).catch(() => {});
          fatalCoreRecoveryError = error instanceof Error ? error.message : String(error);
          noteActivity({
            title: "Core recovery retrying",
            detail: fatalCoreRecoveryError,
            state: "running",
          });
          await sleep(CORE_RECOVERY_RETRY_MS);
        }
      }
      reopenAdmission();
      return { ok: false, activeSlot: slot, state: "closing" };
    })().finally(() => {
      coreRecoveryPromise = null;
    });
    return coreRecoveryPromise;
  };

  const watchActiveHandle = (handle, slot) => {
    const child = handle?.child;
    if (!child || typeof child.once !== "function") return;
    child.once("exit", (code, signal) => {
      if (closing || handle !== activeHandle || slot !== activeSlot) return;
      void recoverActiveCore({ handle, slot, code, signal });
    });
  };

  const start = async () => {
    if (proxy) return status();
    if (!activeHandle) activeHandle = await startActive(activeSlot);
    proxy = createStableGatewayProxy({
      activeCore: { id: slotId(activeSlot), baseUrl: activeHandle.baseUrl },
      publicBaseUrl: publicBase,
      registry,
      activityJournal,
    });
    watchActiveHandle(activeHandle, activeSlot);
    return status();
  };

  const handlePublicRequest = (req, res) => {
    if (!proxy) {
      sendUnavailable(res, "Stable Gateway is not started.");
      return;
    }
    const replayableStream = isReplayableMcpEventStream(req);
    const admit = replayableStream
      ? admission.waitForOpen()
      : admission.enter();
    void admit
      .then(() => {
        if (replayableStream) {
          proxy.handler(req, res);
          return;
        }
        let left = false;
        const leave = () => {
          if (left) return;
          left = true;
          admission.leave();
        };
        res.once("finish", leave);
        res.once("close", leave);
        proxy.handler(req, res);
      })
      .catch((error) => sendUnavailable(res, error instanceof Error ? error.message : String(error)));
  };

  const rollback = async ({ oldSlot, baseline, baselineFingerprint, failedHandle }) => {
    if (failedHandle) await stopCoreSlot(failedHandle).catch(() => {});
    const rollbackHandle = await startActive(oldSlot);
    await verifyCore(rollbackHandle, baseline, baselineFingerprint);
    const replayed = await proxy.replaySessionsToCore({ id: slotId(oldSlot), baseUrl: rollbackHandle.baseUrl });
    registry.commitMappings(replayed.mappings);
    proxy.setActiveCore({ id: slotId(oldSlot), baseUrl: rollbackHandle.baseUrl });
    activeSlot = oldSlot;
    activeHandle = rollbackHandle;
    watchActiveHandle(rollbackHandle, oldSlot);
    return {
      activeSlot,
      activePid: rollbackHandle.pid ?? null,
      replayedSessions: replayed.mappings.length,
      droppedSessions: replayed.droppedPublicSessionIds.length,
      deferredSessions: replayed.deferredPublicSessionIds.length,
      replayFailureReasons: replayed.failureReasonCounts,
    };
  };

  const handover = async ({ allowSchemaChange = false } = {}) => {
    if (!proxy || !activeHandle) throw new Error("Stable Gateway is not started.");
    if (handoverInProgress) throw new Error("Stable Gateway handover is already in progress.");
    if (coreRecoveryPromise) throw new Error("Stable Gateway Core recovery is in progress.");
    if (fatalHandoverError) throw new Error(`Stable Gateway is blocked after fatal rollback failure: ${fatalHandoverError}`);
    handoverInProgress = true;
    const oldSlot = activeSlot;
    const nextSlot = oldSlot === "a" ? "b" : "a";
    const oldHandle = activeHandle;
    let baseline = null;
    let snapshot = null;
    let candidateHandle = null;
    let replacementHandle = null;
    let oldStopped = false;
    let barrierStarted = false;
    let baselineFingerprint;
    let candidateResult;
    const startedAt = Date.now();

    try {
      const resolvedBaseline = await resolveBaselineSchema(oldHandle.baseUrl);
      baseline = resolvedBaseline.baseline;
      const baselineSchema = resolvedBaseline.schema;
      baselineFingerprint = baselineSchema.schemaFingerprint;
      const baselineToolCount = Number(baselineSchema.toolCount);
      if (!Number.isInteger(baselineToolCount) || baselineToolCount < 1) {
        throw new Error("Active Core did not return a valid non-empty model surface.");
      }

      snapshot = await createCandidateSnapshot({ sourceStateDir: statePath });
      candidateHandle = await startCandidate(nextSlot, snapshot.stateDir);
      candidateResult = await verifyCore(candidateHandle, baseline, baselineFingerprint, {
        allowSchemaChange: allowSchemaChange === true,
      });
      const candidateFingerprint = candidateResult.schemaFingerprint;
      if (!/^[a-f0-9]{64}$/i.test(String(candidateFingerprint || ""))) {
        throw new Error("Candidate Core did not return a verified model-surface fingerprint.");
      }
      const schemaChanged = candidateFingerprint !== baselineFingerprint;
      if (schemaChanged && allowSchemaChange !== true) {
        throw new Error("Candidate Core model surface changed without explicit schema-change authorization.");
      }
      const candidateToolCount = Number(candidateResult.toolCount);
      if (!Number.isInteger(candidateToolCount) || candidateToolCount < 1) {
        throw new Error("Candidate Core did not return a valid non-empty model surface.");
      }
      if (schemaChanged && candidateToolCount !== baselineToolCount) {
        throw new Error(`Schema-changing handover changed the tool count from ${baselineToolCount} to ${candidateToolCount}; this requires a separate reviewed tool-surface migration.`);
      }
      await ensureStopped(candidateHandle, "Candidate Core");
      candidateHandle = null;
      await snapshot.cleanup();
      snapshot = null;

      admission.closeAdmission();
      registry.beginBarrier();
      barrierStarted = true;
      await Promise.all([
        admission.waitForDrain(),
        registry.waitForDrain(),
      ]);

      await ensureStopped(oldHandle, "Active Core");
      oldStopped = true;
      replacementHandle = await startActive(nextSlot);
      // The production replacement must exactly match the already-validated
      // candidate.  Even an explicitly authorized schema migration may not
      // promote a different build between candidate and active startup.
      await verifyCore(replacementHandle, baseline, candidateFingerprint);
      const replayed = await proxy.replaySessionsToCore({ id: slotId(nextSlot), baseUrl: replacementHandle.baseUrl });
      registry.commitMappings(replayed.mappings);
      proxy.setActiveCore({ id: slotId(nextSlot), baseUrl: replacementHandle.baseUrl });
      activeSlot = nextSlot;
      activeHandle = replacementHandle;
      watchActiveHandle(activeHandle, nextSlot);
      replacementHandle = null;
      reopenAdmission();
      barrierStarted = false;
      return {
        ok: true,
        state: "handed-over",
        activeSlot,
        activePid: activeHandle.pid ?? null,
        candidateStage: candidateResult?.stage ?? "compatible",
        schemaChanged,
        previousSchemaFingerprint: baselineFingerprint,
        schemaFingerprint: candidateFingerprint,
        requiresFreshInitialize: schemaChanged,
        replayedSessions: replayed.mappings.length,
        droppedSessions: replayed.droppedPublicSessionIds.length,
        deferredSessions: replayed.deferredPublicSessionIds.length,
        replayFailureReasons: replayed.failureReasonCounts,
        rollback: false,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (candidateHandle) await stopCoreSlot(candidateHandle).catch(() => {});
      if (snapshot) await snapshot.cleanup().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      if (!oldStopped) {
        if (barrierStarted) reopenAdmission();
        throw error;
      }
      try {
        const restored = await rollback({
          oldSlot,
          baseline,
          baselineFingerprint,
          failedHandle: replacementHandle,
        });
        reopenAdmission();
        barrierStarted = false;
        return {
          ok: false,
          state: "rolled-back",
          activeSlot: restored.activeSlot,
          activePid: restored.activePid,
          replayedSessions: restored.replayedSessions,
          droppedSessions: restored.droppedSessions,
          deferredSessions: restored.deferredSessions,
          replayFailureReasons: restored.replayFailureReasons,
          rollback: true,
          error: message,
          durationMs: Date.now() - startedAt,
        };
      } catch (rollbackError) {
        fatalHandoverError = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`Stable Gateway handover failed (${message}) and rollback failed (${fatalHandoverError}).`);
      }
    } finally {
      handoverInProgress = false;
      const deferred = deferredCoreExit;
      deferredCoreExit = null;
      if (deferred && deferred.handle === activeHandle && deferred.slot === activeSlot && !closing) {
        void recoverActiveCore(deferred);
      }
    }
  };

  const close = async () => {
    closing = true;
    reopenAdmission();
    if (activeHandle) await stopCoreSlot(activeHandle).catch(() => {});
    activeHandle = null;
    proxy = null;
  };

  function status() {
    return {
      ok: Boolean(proxy && activeHandle && !fatalHandoverError && !fatalCoreRecoveryError && !coreRecoveryPromise),
      activeSlot,
      activePid: activeHandle?.pid ?? null,
      handoverInProgress,
      coreRecoveryInProgress: Boolean(coreRecoveryPromise),
      fatal: Boolean(fatalHandoverError),
      fatalCoreRecoveryError: null,
      coreRecoveryLastError: fatalCoreRecoveryError,
      admission: admission.snapshot(),
      sessions: registry.snapshotPublic(),
    };
  }

  return {
    start,
    close,
    handover,
    handlePublicRequest,
    status,
    registry,
  };
}
