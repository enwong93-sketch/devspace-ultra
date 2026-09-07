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
  const normalized = normalizeInput(info.action, input);
  const code = operationCode(info.action, normalized);
  const response = await callJsReplCompatibility(dependencies, {
    code,
    timeoutMs: Math.max(1_000, Math.min(120_000, Number(timeoutMs) || 30_000)),
  });
  const parsed = parseNodeReplPayload(response);
  return {
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
    },
    executionPolicy: executionPolicySnapshot(),
  };
}

export async function codexComputerUseStatus(dependencies) {
  return await callCodexComputerUse(dependencies, { action: "status", input: {}, timeoutMs: 30_000 });
}
