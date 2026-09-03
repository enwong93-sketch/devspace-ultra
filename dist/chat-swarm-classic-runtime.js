import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as z from "zod/v4";

const execFileAsync = promisify(execFile);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(moduleDir, "..");
const controllerScript = resolve(packageRoot, "scripts", "chat-swarm-classic-controller.ps1");
const updateManagerScript = resolve(packageRoot, "scripts", "chat-swarm-classic-update-manager.ps1");
const identityScript = resolve(packageRoot, "scripts", "chat-swarm-classic-runtime-identity.ps1");
const MAX_OUTPUT = 4 * 1024 * 1024;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

function textResult(structuredContent, text) {
  return { content: [{ type: "text", text }], structuredContent };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { ok: false, error: message },
  };
}

function addCommon(args, input = {}) {
  if (input.count !== undefined) args.push("-Count", String(input.count));
  if (input.firstWorker !== undefined) args.push("-FirstWorker", String(input.firstWorker));
  if (Array.isArray(input.workers) && input.workers.length) args.push("-WorkerNumbers", input.workers.join(","));
  return args;
}

export function productionRuntimeNumbers(desiredWorkers, reservedWorkers = []) {
  const reserved = new Set(reservedWorkers.map((value) => Number(value)));
  const available = [];
  for (let number = 1; number <= 32; number += 1) {
    if (!reserved.has(number)) available.push(number);
  }
  if (!Number.isInteger(desiredWorkers) || desiredWorkers < 0 || desiredWorkers > available.length) {
    throw new Error(`desiredWorkers must be between 0 and ${available.length} after reserved runtime numbers.`);
  }
  return available.slice(0, desiredWorkers);
}

async function runController(action, input = {}, timeoutMs = 150_000) {
  if (process.platform !== "win32") {
    throw new Error("ChatGPT Classic runtime control is currently supported only on Windows.");
  }

  const args = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", controllerScript,
    "-Action", action,
  ];
  addCommon(args, input);
  if (input.worker !== undefined) args.push("-Worker", String(input.worker));
  if (input.desiredWorkers !== undefined) args.push("-DesiredWorkers", String(input.desiredWorkers));
  if (Array.isArray(input.reservedWorkers) && input.reservedWorkers.length) args.push("-ReservedWorkerNumbers", input.reservedWorkers.join(","));
  if (input.inviteCode) args.push("-InviteCode", String(input.inviteCode));
  if (input.projectUrl) args.push("-ProjectUrl", String(input.projectUrl));
  if (input.staggerSeconds !== undefined) args.push("-StaggerSeconds", String(input.staggerSeconds));
  if (input.enableAutomation) args.push("-EnableAutomation");
  if (input.restartForAutomation) args.push("-RestartForAutomation");
  if (input.noMinimize) args.push("-NoMinimize");
  if (input.forceRefresh) args.push("-ForceRefresh");

  const { stdout, stderr } = await execFileAsync("powershell.exe", args, {
    cwd: packageRoot,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT,
    encoding: "utf8",
  });
  const output = String(stdout || "").trim();
  const errorText = String(stderr || "").trim();
  return {
    ok: true,
    action,
    output,
    stderr: errorText || undefined,
  };
}

async function runIdentityManager(action, timeoutMs = 240_000) {
  if (process.platform !== "win32") {
    throw new Error("ChatGPT Classic runtime identity management is currently supported only on Windows.");
  }
  const { stdout, stderr } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", identityScript,
    "-Action", action,
  ], {
    cwd: packageRoot,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT,
    encoding: "utf8",
  });
  const output = String(stdout || "").trim();
  const errorText = String(stderr || "").trim();
  let parsed;
  try { parsed = output ? JSON.parse(output) : {}; }
  catch { throw new Error(`Runtime identity manager returned invalid JSON: ${output.slice(0, 2_000)}`); }
  return { ...parsed, stderr: errorText || undefined };
}

async function runUpdateManager(action, input = {}, timeoutMs = 300_000) {
  if (process.platform !== "win32") {
    throw new Error("ChatGPT Classic update management is currently supported only on Windows.");
  }
  const args = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", updateManagerScript,
    "-Action", action,
  ];
  if (input.canaryWorker !== undefined) args.push("-CanaryWorker", String(input.canaryWorker));
  if (Array.isArray(input.workers) && input.workers.length) args.push("-WorkerNumbers", input.workers.join(","));
  if (input.validatedVersion) args.push("-ValidatedVersion", String(input.validatedVersion));
  const { stdout, stderr } = await execFileAsync("powershell.exe", args, {
    cwd: packageRoot,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT,
    encoding: "utf8",
  });
  const output = String(stdout || "").trim();
  const errorText = String(stderr || "").trim();
  let parsed;
  try { parsed = output ? JSON.parse(output) : {}; }
  catch { throw new Error(`Update manager returned invalid JSON: ${output}`); }
  return { ...parsed, stderr: errorText || undefined };
}

const poolSchema = {
  count: z.number().int().min(1).max(32).default(4),
  firstWorker: z.number().int().min(1).max(32).default(1),
  workers: z.array(z.number().int().min(1).max(32)).max(32).optional(),
};

function parseControllerJson(result, action) {
  const output = String(result?.output || "").trim();
  try {
    return output ? JSON.parse(output) : {};
  } catch {
    throw new Error(`ChatGPT Classic controller ${action} returned invalid JSON: ${output.slice(0, 2_000)}`);
  }
}

export async function planClassicRuntimePool(input) {
  const raw = await runController("plan", input, 45_000);
  const plan = parseControllerJson(raw, "plan");
  const runtimeNumbers = Array.isArray(plan.ProductionWorkerNumbers)
    ? plan.ProductionWorkerNumbers.map((value) => Number(value))
    : [];
  if (runtimeNumbers.some((value) => !Number.isInteger(value) || value < 1 || value > 32)) {
    throw new Error(`Controller returned invalid production runtime plan: ${JSON.stringify(plan)}`);
  }
  return {
    ok: plan.Ok !== false,
    desiredWorkers: Number(plan.DesiredWorkers ?? input.desiredWorkers ?? runtimeNumbers.length),
    runtimeNumbers,
    reservedWorkers: Array.isArray(plan.ReservedWorkers) ? plan.ReservedWorkers.map(Number) : [],
    protectedWorkers: Array.isArray(plan.ProtectedWorkers) ? plan.ProtectedWorkers.map(Number) : [],
  };
}

export async function scaleClassicRuntimePool(input) {
  const plan = await planClassicRuntimePool(input);
  const result = await runController("scale", input, 360_000);
  return { ...result, plan, runtimeNumbers: plan.runtimeNumbers, protectedWorkers: plan.protectedWorkers, reservedWorkers: plan.reservedWorkers };
}

export async function autojoinClassicRuntimeWorkers(input) {
  return await runController("autojoin", input, 300_000);
}

async function runUpdateCanary(coordinator, input = {}) {
  if (!coordinator) throw new Error("Chat Swarm coordinator is required for update canary validation.");
  const canaryWorker = input.canaryWorker ?? 32;
  const prepared = await runUpdateManager("prepare-canary", { canaryWorker }, 360_000);
  if (!prepared.Ok) throw new Error(`Canary preparation failed for worker-${String(canaryWorker).padStart(2, "0")}.`);

  let created;
  try {
    created = await coordinator.create({
      name: `chatgpt-update-canary-${prepared.PrimaryVersion}`,
      workerSlots: 1,
      peer: { identitySource: "runtime-update-canary", identityFingerprint: `runtime-${canaryWorker}` },
    });
    await autojoinClassicRuntimeWorkers({
      workers: [canaryWorker],
      inviteCode: created.inviteCode,
      projectUrl: input.projectUrl,
      staggerSeconds: 0,
    });

    const joinDeadline = Date.now() + (input.joinWaitSeconds ?? 90) * 1000;
    let status = await coordinator.status(created.orchestratorToken);
    while (status.activeWorkers < 1 && Date.now() < joinDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      status = await coordinator.status(created.orchestratorToken);
    }
    if (status.activeWorkers !== 1) {
      throw new Error("Canary runtime started, but its ChatGPT conversation did not join the canary swarm before timeout.");
    }

    const workerId = status.workers[0].workerId;
    const dispatched = await coordinator.dispatch({
      orchestratorToken: created.orchestratorToken,
      tasks: [{
        prompt: "ChatGPT Classic update compatibility canary. Without browsing, calculate 21 + 21 and submit a short natural-language answer containing the result.",
        targetWorkerId: workerId,
        taskKey: "update-canary-natural-42",
      }],
    });
    const taskId = dispatched.tasks[0].taskId;
    const taskDeadline = Date.now() + (input.taskWaitSeconds ?? 120) * 1000;
    let collected;
    do {
      collected = await coordinator.collect({
        orchestratorToken: created.orchestratorToken,
        taskIds: [taskId],
        waitFor: "none",
        waitMs: 0,
      });
      const task = collected.tasks[0];
      if (["completed", "failed", "cancelled"].includes(task?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } while (Date.now() < taskDeadline);

    const task = collected?.tasks?.[0];
    const passed = task?.status === "completed" && /\b42\b/.test(String(task.result ?? ""));
    if (!passed) {
      throw new Error(`Canary task did not pass: status=${task?.status ?? "unknown"}, result=${String(task?.result ?? "").slice(0, 500)}, error=${String(task?.error ?? "").slice(0, 500)}`);
    }
    return {
      ok: true,
      validatedVersion: prepared.PrimaryVersion,
      canaryWorker,
      canaryRuntime: prepared,
      task,
    };
  }
  finally {
    if (created) {
      try { await coordinator.closeSwarm({ orchestratorToken: created.orchestratorToken, cancelPending: true }); } catch {}
    }
    try { await runController("stop", { workers: [canaryWorker] }, 90_000); } catch {}
  }
}

export function registerChatSwarmClassicRuntimeTools(server, coordinator) {
  if (coordinator) {
    server.registerTool("chat_swarm_update_canary", {
      title: "Validate ChatGPT Classic Update Canary",
      description: "Safely validate the currently installed primary ChatGPT Classic version on an isolated canary runtime before touching production workers. The tool clones a free canary runtime, provisions login state, verifies CDP/UI health, creates a temporary one-worker swarm, auto-joins the canary, runs a real task through join/next/submit, closes the canary swarm, and stops the canary runtime. Production workers and configured reserved runtime numbers are not modified.",
      inputSchema: {
        canaryWorker: z.number().int().min(1).max(32).default(32),
        projectUrl: z.string().url().optional(),
        joinWaitSeconds: z.number().int().min(10).max(180).default(90),
        taskWaitSeconds: z.number().int().min(15).max(240).default(120),
      },
      annotations: MUTATING,
    }, async (input) => {
      try {
        const result = await runUpdateCanary(coordinator, input);
        return textResult(result, `Canary PASS for ChatGPT Classic ${result.validatedVersion} on Runtime-${String(result.canaryWorker).padStart(2, "0")}.`);
      }
      catch (error) { return errorResult(error); }
    });

    server.registerTool("chat_swarm_update_ensure_compatible", {
      title: "Ensure ChatGPT Classic Worker Update Compatibility",
      description: "Production update guard. Checks worker clone versions against the installed primary ChatGPT Classic app. If no drift exists it returns immediately. If drift exists, it first runs an isolated real-task canary; only after the canary passes does it perform a rolling production worker update with per-worker session backup, exact-conversation recovery, version verification, and automatic rollback on the first failed worker. Configured reserved runtime numbers remain outside the saved production pool unless explicitly listed in workers.",
      inputSchema: {
        canaryWorker: z.number().int().min(1).max(32).default(32),
        projectUrl: z.string().url().optional(),
        workers: z.array(z.number().int().min(1).max(32)).max(31).optional(),
      },
      annotations: MUTATING,
    }, async (input) => {
      try {
        const status = await runUpdateManager("status", {}, 60_000);
        if (Number(status.DriftCount ?? 0) === 0) {
          return textResult({ ok: true, changed: false, status }, `All registered worker runtimes already match ChatGPT Classic ${status.PrimaryVersion}; no update required.`);
        }
        const canary = await runUpdateCanary(coordinator, input);
        const rollout = await runUpdateManager("rollout", {
          validatedVersion: canary.validatedVersion,
          workers: input.workers,
        }, 900_000);
        return textResult({ ok: true, changed: true, before: status, canary, rollout }, `Update compatibility PASS and rolling worker update completed for ChatGPT Classic ${canary.validatedVersion}.`);
      }
      catch (error) { return errorResult(error); }
    });

    server.registerTool("chat_swarm_elastic_scale", {
      title: "Elastic Scale Chat Swarm",
      description: "High-level production scaling for an active Chat Swarm. The orchestrator chooses the desired worker count from actual workload. The tool safely resizes backend capacity, provisions/starts/stops isolated ChatGPT Classic runtimes, skips any runtime numbers explicitly reserved by the operator, reuses saved worker conversations when scaling back up, auto-joins newly needed workers, and waits briefly for the requested active capacity. Shrinking never interrupts busy or targeted workers; it fails safely instead.",
      inputSchema: {
        orchestratorToken: z.string().min(16),
        desiredWorkers: z.number().int().min(0).max(32),
        inviteCode: z.string().min(6).max(64).optional(),
        projectUrl: z.string().url().optional(),
        reservedWorkers: z.array(z.number().int().min(1).max(32)).max(32).default([]),
        staggerSeconds: z.number().int().min(0).max(30).default(4),
        waitSeconds: z.number().int().min(0).max(120).default(75),
      },
      annotations: MUTATING,
    }, async (input) => {
      try {
        const runtimePlan = await planClassicRuntimePool({ desiredWorkers: input.desiredWorkers, reservedWorkers: input.reservedWorkers });
        const runtimeNumbers = runtimePlan.runtimeNumbers;
        const desiredLabels = runtimeNumbers.map((number) => `Runtime-${String(number).padStart(2, "0")}`);
        const before = await coordinator.status(input.orchestratorToken);
        let resize;
        let runtimeResult;

        if (input.desiredWorkers < before.activeWorkers) {
          resize = await coordinator.resize({ orchestratorToken: input.orchestratorToken, workerSlots: input.desiredWorkers });
          runtimeResult = await scaleClassicRuntimePool({ desiredWorkers: input.desiredWorkers, reservedWorkers: input.reservedWorkers });
        }
        else {
          runtimeResult = await scaleClassicRuntimePool({ desiredWorkers: input.desiredWorkers, reservedWorkers: input.reservedWorkers });
          resize = await coordinator.resize({ orchestratorToken: input.orchestratorToken, workerSlots: input.desiredWorkers });
        }

        let current = await coordinator.status(input.orchestratorToken);
        const activeLabels = new Set(current.workers.map((worker) => worker.label));
        const missingNumbers = runtimeNumbers.filter((number) => !activeLabels.has(`Runtime-${String(number).padStart(2, "0")}`));
        let bootstrapResult;
        if (missingNumbers.length) {
          const inviteCode = input.inviteCode || coordinator.getJoinInvite(input.orchestratorToken);
          if (!inviteCode) {
            throw new Error("Scaling up needs the swarm invite code because this swarm has no previous worker membership to recover it from.");
          }
          bootstrapResult = await autojoinClassicRuntimeWorkers({
            workers: missingNumbers,
            inviteCode,
            projectUrl: input.projectUrl,
            staggerSeconds: input.staggerSeconds,
          });

          const deadline = Date.now() + input.waitSeconds * 1000;
          do {
            if (current.activeWorkers >= input.desiredWorkers) break;
            await new Promise((resolve) => setTimeout(resolve, 1500));
            current = await coordinator.status(input.orchestratorToken);
          } while (Date.now() < deadline);
        }

        current = await coordinator.status(input.orchestratorToken);
        const complete = current.activeWorkers === input.desiredWorkers;
        const result = {
          ok: complete,
          desiredWorkers: input.desiredWorkers,
          runtimeNumbers,
          desiredLabels,
          protectedWorkers: runtimePlan.protectedWorkers,
          effectiveReservedWorkers: runtimePlan.reservedWorkers,
          resize,
          runtime: runtimeResult,
          bootstrap: bootstrapResult,
          swarm: current,
          complete,
        };
        if (!complete) {
          return {
            isError: true,
            content: [{ type: "text", text: `Elastic scale reached ${current.activeWorkers}/${input.desiredWorkers} active workers before timeout; local runtimes were prepared and can continue joining in the background.` }],
            structuredContent: result,
          };
        }
        const excluded = [...new Set([...runtimePlan.reservedWorkers, ...runtimePlan.protectedWorkers])].sort((a, b) => a - b);
        const reservationText = excluded.length
          ? ` Excluded reserved/protected runtime numbers: ${excluded.join(", ")}.`
          : " No runtime numbers are excluded by controller policy.";
        return textResult(result, `Elastic scale complete: ${current.activeWorkers}/${input.desiredWorkers} workers active.${reservationText}`);
      }
      catch (error) { return errorResult(error); }
    });
  }

  server.registerTool("chat_swarm_runtime_identity_status", {
    title: "ChatGPT Runtime Identity Status",
    description: "Audit Primary ChatGPT versus isolated Worker runtime identity without changing processes. Reports the current chatgpt:// protocol owner, Primary visibility, worker manifest/registration isolation, and any protected interactive runtimes or pending migrations.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => {
    try {
      const result = await runIdentityManager("audit", 90_000);
      const protocol = result.Protocol?.ApplicationName || "unassigned";
      const pending = Array.isArray(result.PendingRunningMigration) ? result.PendingRunningMigration : [];
      return textResult(result, `Runtime identity audit: primary visible=${Boolean(result.Primary?.Visible)}; chatgpt:// owner=${protocol}; pending protected/running migrations=${pending.join(",") || "none"}.`);
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("chat_swarm_runtime_identity_repair", {
    title: "Repair ChatGPT Runtime Identity",
    description: "Repair stale Worker package identity registrations without terminating running workers. Inactive workers are sanitized/re-registered so they cannot own chatgpt://, startup, Copilot-key, or normal app-list launch surfaces; running dirty workers are left pending/protected. Also activates the explicit Primary ChatGPT window when needed.",
    inputSchema: {},
    annotations: MUTATING,
  }, async () => {
    try {
      const result = await runIdentityManager("guard", 300_000);
      return textResult(result, `Runtime identity guard complete. Primary=${result.PrimaryGuard?.State || "unknown"}; protocol misroute=${result.ProtocolMisroute?.State || "none"}; pending migrations=${(result.Snapshot?.PendingRunningMigration || []).join(",") || "none"}.`);
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("chat_swarm_update_status", {
    title: "ChatGPT Classic Worker Update Status",
    description: "Compare every registered isolated ChatGPT Classic worker clone with the currently installed primary ChatGPT Classic version and report version drift. Read-only.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => {
    try {
      const result = await runUpdateManager("status", {}, 60_000);
      return textResult(result, `Primary ChatGPT Classic ${result.PrimaryVersion}; ${result.DriftCount} worker runtime(s) out of date.`);
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("chat_swarm_update_rollout", {
    title: "Roll Out Validated ChatGPT Classic Update",
    description: "Roll a previously canary-validated ChatGPT Classic version across production worker runtimes. Each worker is backed up, updated one at a time, returned to its saved conversation, verified, and automatically rolled back if that worker fails. Saved protected interactive runtimes are never valid rollout targets; default selection also excludes reserved runtimes.",
    inputSchema: {
      validatedVersion: z.string().min(1),
      workers: z.array(z.number().int().min(1).max(32)).max(31).optional(),
    },
    annotations: MUTATING,
  }, async (input) => {
    try {
      const result = await runUpdateManager("rollout", input, 900_000);
      return textResult(result, `Rolling update completed for validated ChatGPT Classic ${input.validatedVersion}.`);
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("chat_swarm_runtime_scale", {
    title: "Scale Chat Swarm Runtime Pool",
    description: "Elastic local runtime scaling for production ChatGPT Classic workers. The Windows controller is the source of truth for runtime numbering and excludes both operator-reserved and protected interactive runtimes. It provisions/starts the remaining workers and stops only unprotected excess workers. This changes local runtime capacity only; use chat_swarm_resize or chat_swarm_elastic_scale to change live swarm membership.",
    inputSchema: {
      desiredWorkers: z.number().int().min(0).max(32),
      reservedWorkers: z.array(z.number().int().min(1).max(32)).max(32).default([]),
    },
    annotations: MUTATING,
  }, async (input) => {
    try {
      const result = await scaleClassicRuntimePool(input);
      return textResult({ ...result, desiredWorkers: input.desiredWorkers, runtimeNumbers: result.runtimeNumbers }, result.output || `Runtime pool scaled to ${input.desiredWorkers}.`);
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("chat_swarm_runtime_status", {
    title: "Chat Swarm Runtime Status",
    description: "Inspect the isolated ChatGPT Classic runtime pool. The convenience default inspects workers 01-04; any runtime reservation policy is configured separately by the operator.",
    inputSchema: poolSchema,
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const result = await runController("status", input, 45_000);
      return textResult(result, result.output || "Runtime status completed.");
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("chat_swarm_runtime_ensure", {
    title: "Ensure Chat Swarm Runtimes",
    description: "Make the saved ChatGPT Classic worker pool healthy. Starts/reopens ordinary workers, restores saved conversations, resumes interrupted loops, and minimizes worker windows. Protected interactive runtimes are reported as protected-skip and are never navigated, restarted, resumed, or minimized unless protection is explicitly removed outside this tool.",
    inputSchema: poolSchema,
    annotations: MUTATING,
  }, async (input) => {
    try {
      const result = await runController("ensure", input);
      return textResult(result, result.output || "Worker pool ensured.");
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("chat_swarm_runtime_recover", {
    title: "Recover Chat Swarm Runtime",
    description: "Recover one isolated ChatGPT Classic worker using its saved exact conversation mapping. Does not require storing the raw workerToken on disk.",
    inputSchema: {
      worker: z.number().int().min(1).max(32),
    },
    annotations: MUTATING,
  }, async (input) => {
    try {
      const result = await runController("recover", input);
      return textResult(result, result.output || `Worker ${input.worker} recovered.`);
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("chat_swarm_runtime_autojoin", {
    title: "Auto-Join Chat Swarm Runtimes",
    description: "Bootstrap a worker pool into a newly created Chat Swarm without manual copy/paste. New worker conversations are created inside the configured sub-agents ChatGPT Project when available; DevSpace backend remains the task-routing layer after join.",
    inputSchema: {
      inviteCode: z.string().min(6).max(64),
      ...poolSchema,
      projectUrl: z.string().url().optional(),
      staggerSeconds: z.number().int().min(0).max(120).default(8),
    },
    annotations: MUTATING,
  }, async (input) => {
    try {
      const result = await runController("autojoin", input, 240_000);
      return textResult(result, result.output || "Worker bootstrap sent.");
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("chat_swarm_runtime_setup", {
    title: "Setup Chat Swarm Runtimes",
    description: "Create/register isolated ChatGPT Classic runtime clones for a requested worker range. Use this only when expanding or repairing the local runtime pool; it does not join a swarm.",
    inputSchema: {
      ...poolSchema,
      forceRefresh: z.boolean().default(false),
    },
    annotations: MUTATING,
  }, async (input) => {
    try {
      const result = await runController("setup", input, 300_000);
      return textResult(result, result.output || "Runtime setup completed.");
    }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("chat_swarm_runtime_stop", {
    title: "Stop Chat Swarm Runtimes",
    description: "Stop only selected isolated ChatGPT Classic worker runtimes. The primary app is never targeted, and protected interactive runtimes are hard-refused at the lowest stop layer so indirect stop paths cannot terminate them.",
    inputSchema: poolSchema,
    annotations: MUTATING,
  }, async (input) => {
    try {
      const result = await runController("stop", input, 90_000);
      return textResult(result, result.output || "Selected worker runtimes stopped.");
    }
    catch (error) { return errorResult(error); }
  });
}
