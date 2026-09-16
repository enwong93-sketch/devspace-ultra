import { callJsReplCompatibility } from "./js-repl-compat.js";
import { executionPolicySnapshot } from "./execution-policy.js";

export const CODEX_COMPUTER_USE_SKILL_NAME = "computer-use";
export const CODEX_COMPUTER_USE_PLUGIN_ID = "computer-use@openai-bundled";
export const CODEX_COMPUTER_USE_RUNTIME = "@oai/sky";

const ACTIONS = new Set([
  "status",
  "list_apps",
  "list_windows",
  "get_window",
  "get_window_state",
  "launch_app",
  "click",
  "press_key",
  "type_text",
  "scroll",
  "set_value",
  "drag",
  "perform_secondary_action",
  "activate_window",
]);

const MUTATING_ACTIONS = new Set([
  "launch_app",
  "click",
  "press_key",
  "type_text",
  "scroll",
  "set_value",
  "drag",
  "perform_secondary_action",
  "activate_window",
]);

const PROHIBITED_APP_PATTERN = /(?:chatgpt|openai\.codex|\bcodex\b|windows\s*terminal|terminal|powershell|pwsh|cmd\.exe|command\s*prompt|conhost|wt\.exe)/i;

function boundedString(value, max, label) {
  if (value == null) return undefined;
  const text = String(value);
  if (!text.trim()) throw new Error(`${label} must not be empty.`);
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters.`);
  return text;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number.`);
  return number;
}

function integer(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${label} must be an integer.`);
  return number;
}

function normalizeWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("window must be a Window object returned by Computer Use.");
  return {
    id: integer(value.id, "window.id"),
    app: boundedString(value.app, 4096, "window.app"),
    ...(value.title == null ? {} : { title: boundedString(value.title, 2000, "window.title") }),
  };
}

function comparableApp(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sameApp(left, right) {
  const a = comparableApp(left);
  const b = comparableApp(right);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));
}

function targetApp(action, input) {
  if (["status", "list_apps", "list_windows"].includes(action)) return null;
  return String(input?.window?.app || input?.app || "").trim() || null;
}

function assertAllowedApp(app) {
  if (!app) return;
  if (PROHIBITED_APP_PATTERN.test(app)) {
    throw new Error(`Codex Computer Use is not permitted to operate prohibited app ${app}.`);
  }
}

function hostElicitationUnsupported(error) {
  return /elicitation (?:is )?not supported|does not support the computer use approval prompt/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

export function validateComputerUseElicitation(request, expectedApp) {
  const params = request?.params && typeof request.params === "object"
    ? request.params
    : request && typeof request === "object"
      ? request
      : {};
  const meta = params?.meta && typeof params.meta === "object"
    ? params.meta
    : params?._meta && typeof params._meta === "object"
      ? params._meta
      : {};
  if (String(meta.connector_id || "") !== "computer-use") {
    throw new Error("Rejected an elicitation that was not issued by the official Computer Use connector.");
  }
  const requestedApp = String(meta?.tool_params?.app || "").trim();
  if (expectedApp && requestedApp && !sameApp(expectedApp, requestedApp)) {
    throw new Error(`Computer Use approval app mismatch: expected ${expectedApp}, received ${requestedApp}.`);
  }
  if (/computer-audio|record computer audio|microphone/i.test(`${requestedApp} ${params.message || ""}`)) {
    throw new Error("Computer audio approval is outside the DevSpace Computer Use gate.");
  }
  assertAllowedApp(requestedApp || expectedApp);
  return {
    connectorId: "computer-use",
    expectedApp: expectedApp || null,
    requestedApp: requestedApp || null,
    riskLevel: String(meta.riskLevel || "").trim() || null,
  };
}

function normalizeInput(action, input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  switch (action) {
    case "status":
    case "list_apps":
    case "list_windows":
      return {};
    case "get_window":
      return normalizeWindow(source.window || source);
    case "get_window_state":
      return {
        window: normalizeWindow(source.window),
        include_screenshot: source.include_screenshot ?? source.includeScreenshot ?? true,
        include_text: source.include_text ?? source.includeText ?? false,
      };
    case "launch_app":
      return { app: boundedString(source.app, 4096, "app") };
    case "click": {
      const result = { window: normalizeWindow(source.window) };
      if (source.element_index != null || source.elementIndex != null) result.element_index = integer(source.element_index ?? source.elementIndex, "element_index");
      if (source.x != null) result.x = finiteNumber(source.x, "x");
      if (source.y != null) result.y = finiteNumber(source.y, "y");
      if (source.click_count != null || source.clickCount != null) result.click_count = integer(source.click_count ?? source.clickCount, "click_count");
      if (source.mouse_button != null || source.mouseButton != null) result.mouse_button = boundedString(source.mouse_button ?? source.mouseButton, 20, "mouse_button");
      if (source.screenshotId != null) result.screenshotId = boundedString(source.screenshotId, 500, "screenshotId");
      if (result.element_index == null && (result.x == null || result.y == null)) throw new Error("click requires element_index or both x and y.");
      return result;
    }
    case "press_key":
      return { window: normalizeWindow(source.window), key: boundedString(source.key, 500, "key") };
    case "type_text":
      return { window: normalizeWindow(source.window), text: boundedString(source.text, 50_000, "text") };
    case "scroll":
      return {
        window: normalizeWindow(source.window),
        x: finiteNumber(source.x, "x"),
        y: finiteNumber(source.y, "y"),
        scrollX: finiteNumber(source.scrollX ?? source.scroll_x ?? 0, "scrollX"),
        scrollY: finiteNumber(source.scrollY ?? source.scroll_y ?? 0, "scrollY"),
        ...(source.screenshotId == null ? {} : { screenshotId: boundedString(source.screenshotId, 500, "screenshotId") }),
      };
    case "set_value":
      return {
        window: normalizeWindow(source.window),
        element_index: integer(source.element_index ?? source.elementIndex, "element_index"),
        value: boundedString(source.value, 50_000, "value"),
      };
    case "drag":
      return {
        window: normalizeWindow(source.window),
        from_x: finiteNumber(source.from_x ?? source.fromX, "from_x"),
        from_y: finiteNumber(source.from_y ?? source.fromY, "from_y"),
        to_x: finiteNumber(source.to_x ?? source.toX, "to_x"),
        to_y: finiteNumber(source.to_y ?? source.toY, "to_y"),
        ...(source.screenshotId == null ? {} : { screenshotId: boundedString(source.screenshotId, 500, "screenshotId") }),
      };
    case "perform_secondary_action":
      return {
        window: normalizeWindow(source.window),
        element_index: integer(source.element_index ?? source.elementIndex, "element_index"),
        action: boundedString(source.action, 200, "action"),
      };
    case "activate_window":
      return { window: normalizeWindow(source.window) };
    default:
      throw new Error(`Unsupported Codex Computer Use action: ${action}`);
  }
}

function jsString(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function operationCode(action, input) {
  const initialize = `if (!globalThis.sky) { const { sky } = await import(${JSON.stringify(CODEX_COMPUTER_USE_RUNTIME)}); globalThis.sky = sky; }`;
  if (action === "status") {
    return `${initialize} nodeRepl.write(JSON.stringify({ok:true,target:sky.target,runtime:${JSON.stringify(CODEX_COMPUTER_USE_RUNTIME)},pluginId:${JSON.stringify(CODEX_COMPUTER_USE_PLUGIN_ID)}}));`;
  }
  if (action === "list_apps") {
    return `${initialize} globalThis.__devspace_cua_apps = await sky.list_apps(); nodeRepl.write(JSON.stringify(__devspace_cua_apps));`;
  }
  if (action === "list_windows") {
    return `${initialize} globalThis.__devspace_cua_windows = await sky.list_windows(); nodeRepl.write(JSON.stringify(__devspace_cua_windows));`;
  }
  if (action === "get_window") {
    return `${initialize} globalThis.__devspace_cua_window = await sky.get_window(${jsString(input)}); nodeRepl.write(JSON.stringify(__devspace_cua_window));`;
  }
  if (action === "get_window_state") {
    return `${initialize} globalThis.__devspace_cua_state = await sky.get_window_state(${jsString(input)}); globalThis.__devspace_cua_window = __devspace_cua_state.window; globalThis.__devspace_cua_safe_state = { ...__devspace_cua_state, screenshots: (__devspace_cua_state.screenshots || []).map(({ url, ...meta }) => meta) }; nodeRepl.write(JSON.stringify(__devspace_cua_safe_state));`;
  }
  const method = action;
  return `${initialize} globalThis.__devspace_cua_result = await sky.${method}(${jsString(input)}); nodeRepl.write(JSON.stringify({ok:true,action:${JSON.stringify(action)},result:__devspace_cua_result ?? null}));`;
}

function parseNodeReplPayload(response) {
  const result = response?.result ?? response;
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.find((item) => item?.type === "text" && typeof item.text === "string")?.text;
  let structured = null;
  if (text) {
    try { structured = JSON.parse(text); } catch { structured = { text }; }
  }
  return { result, content, structured };
}

export function codexComputerUseActionInfo(action) {
  const normalized = String(action || "status").trim().toLowerCase();
  if (!ACTIONS.has(normalized)) throw new Error(`Unsupported Codex Computer Use action: ${normalized}`);
  return {
    action: normalized,
    readOnly: !MUTATING_ACTIONS.has(normalized),
    mutating: MUTATING_ACTIONS.has(normalized),
    implementation: "openai-bundled-computer-use",
    runtime: CODEX_COMPUTER_USE_RUNTIME,
  };
}

export async function callCodexComputerUse(dependencies, {
  action = "status",
  input = {},
  timeoutMs = 30_000,
} = {}) {
  const info = codexComputerUseActionInfo(action);
  const explicitUserAuthorization = input?.user_authorized_app_control === true;
  const releaseControl = input?.release_control === true || input?.releaseControl === true;
  if (releaseControl && info.mutating) {
    throw new Error("Computer Use release_control is allowed only on the final read-only observation after the last state-changing action.");
  }
  const normalized = normalizeInput(info.action, input);
  const app = targetApp(info.action, normalized);
  assertAllowedApp(app);
  const approvalEvidence = {
    required: false,
    requested: false,
    action: null,
    app,
  };
  const upstreamElicitation = typeof dependencies?.elicitationHandler === "function"
    ? dependencies.elicitationHandler
    : null;
  const elicitationHandler = app
    ? async (request) => {
        const validated = validateComputerUseElicitation(request, app);
        approvalEvidence.required = true;
        approvalEvidence.requested = true;
        if (!upstreamElicitation) return { action: "cancel" };
        approvalEvidence.requestedApp = validated.requestedApp;
        approvalEvidence.riskLevel = validated.riskLevel;
        try {
          const response = await upstreamElicitation(request);
          approvalEvidence.action = String(response?.action || "") || null;
          return response;
        } catch (error) {
          const fallback = typeof dependencies?.allowHostUnsupportedApproval === "function"
            && hostElicitationUnsupported(error)
            && dependencies.allowHostUnsupportedApproval({
              app: validated.requestedApp || app,
              action: info.action,
              readOnly: info.readOnly,
              mutating: info.mutating,
              riskLevel: validated.riskLevel,
              explicitUserAuthorization,
            }) === true;
          if (!fallback) throw error;
          approvalEvidence.action = "accept";
          approvalEvidence.fallback = "host-elicitation-unsupported-exact-conversation-observe-action";
          return { action: "accept" };
        }
      }
    : null;
  const code = operationCode(info.action, normalized);
  const boundedTimeoutMs = Math.max(1_000, Math.min(120_000, Number(timeoutMs) || 30_000));
  const activity = info.action !== "status" && typeof dependencies?.computerUseActivity?.begin === "function"
    ? await dependencies.computerUseActivity.begin({
        conversationId: dependencies.ownerConversationId,
        runtimeKey: dependencies.ownerRuntimeKey,
        app: app || (info.action === "list_apps" || info.action === "list_windows" ? "Windows desktop" : "Windows"),
        action: info.action,
        timeoutMs: boundedTimeoutMs,
      }).catch((error) => ({
        ok: false,
        state: "overlay-begin-failed",
        error: error instanceof Error ? error.message : String(error),
      }))
    : { ok: true, state: info.action === "status" ? "status-read-only" : "overlay-unavailable" };
  let operationState = "failed";
  let result = null;
  let overlayCleanup = null;
  let approvalGrantReleased = false;
  try {
    const response = await callJsReplCompatibility(dependencies, {
      code,
      timeoutMs: boundedTimeoutMs,
      elicitationHandler,
    });
    const parsed = parseNodeReplPayload(response);
    operationState = "completed";
    result = {
      ok: true,
      ...info,
      source: response.source,
      serverId: response.serverId,
      toolName: response.toolName,
      payload: parsed.structured,
      content: parsed.content,
      nativeRuntimeEvidence: {
        nodeRepl: true,
        runtime: CODEX_COMPUTER_USE_RUNTIME,
        devspaceGuiDriver: false,
        approvalRelay: approvalEvidence,
        computerUseOverlay: activity,
      },
      executionPolicy: executionPolicySnapshot(),
    };
  } finally {
    if (activity?.operationId) {
      const mustRelease = releaseControl || operationState !== "completed";
      if (mustRelease && typeof dependencies?.computerUseActivity?.release === "function") {
        overlayCleanup = await dependencies.computerUseActivity.release({
          conversationId: dependencies.ownerConversationId,
          operationId: activity.operationId,
          state: releaseControl ? "agent-released" : operationState,
        }).catch(() => null);
      } else if (typeof dependencies?.computerUseActivity?.end === "function") {
        overlayCleanup = await dependencies.computerUseActivity.end({
          conversationId: dependencies.ownerConversationId,
          operationId: activity.operationId,
          state: operationState,
        }).catch(() => null);
      }
      if (mustRelease && typeof dependencies?.releaseHostUnsupportedApproval === "function") {
        approvalGrantReleased = dependencies.releaseHostUnsupportedApproval(app) === true;
      }
    }
  }
  if (result?.nativeRuntimeEvidence) {
    result.nativeRuntimeEvidence.computerUseOverlay = {
      ...activity,
      cleanup: overlayCleanup,
      released: overlayCleanup?.explicitRelease === true || overlayCleanup?.state === "released",
      releaseRequested: releaseControl,
      approvalGrantReleased,
    };
  }
  return result;
}

export async function codexComputerUseStatus(dependencies) {
  return await callCodexComputerUse(dependencies, { action: "status", input: {}, timeoutMs: 30_000 });
}
