import * as z from "zod/v4";
import { callCodexComputerUse, codexComputerUseStatus } from "./codex-computer-use.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const EXECUTING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const VISUAL_PATTERNS = [
  /\b(?:computer\s*use|desktop|gui|graphical|visible\s+(?:screen|window|control)|screen(?:shot)?|click|scroll|drag|drop|keypress|mouse|keyboard|dialog|menu|browser\s+ui|form\s+ui|canvas)\b/i,
  /(?:畫面|螢幕|熒幕|桌面|視窗|窗口|圖形介面|瀏覽器介面|按鈕|對話框|選單|菜單|點擊|按一下|撳|拖拉|拖曳|捲動|滾動|鍵盤|滑鼠|鼠標|截圖|填寫表格)/u,
];
const NON_VISUAL_PATTERNS = [
  /\b(?:grep|git\s+diff|source\s+code|edit\s+file|write\s+file|shell|terminal|api|http\s+request|json|database\s+query|unit\s+test)\b/i,
  /(?:原始碼|源碼|修改檔案|寫入檔案|命令列|終端機|終端|介面接口|單元測試|資料庫查詢)/u,
];

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { ok: false, error: message },
  };
}

function resultFromComputerUse(result) {
  const metadata = {
    ok: result.ok,
    action: result.action,
    readOnly: result.readOnly,
    mutating: result.mutating,
    implementation: result.implementation,
    runtime: result.runtime,
    source: result.source,
    serverId: result.serverId,
    toolName: result.toolName,
    nativeRuntimeEvidence: result.nativeRuntimeEvidence,
    executionPolicy: result.executionPolicy,
    payload: result.payload,
  };
  const content = Array.isArray(result.content) && result.content.length
    ? [...result.content]
    : [{ type: "text", text: JSON.stringify(metadata, null, 2) }];
  return { content, structuredContent: metadata };
}

export function codexComputerUseRoute(task) {
  const text = String(task || "").trim();
  if (!text) return { useComputer: false, score: 0, reason: "empty-task" };
  let score = 0;
  for (const pattern of VISUAL_PATTERNS) if (pattern.test(text)) score += 3;
  for (const pattern of NON_VISUAL_PATTERNS) if (pattern.test(text)) score -= 2;
  const useComputer = score > 0;
  return {
    useComputer,
    score,
    reason: useComputer ? "visual-interface-required" : "workspace-tools-preferred",
    recommendedTool: useComputer ? "codex_computer_use" : null,
  };
}

export function registerCodexComputerUseRouter(server, {
  capabilityRuntime,
  codexMcpBridge,
  resolveConversation = null,
} = {}) {
  if (!codexMcpBridge && !capabilityRuntime) throw new Error("Linked Codex node_repl or Capability Runtime is required for Computer Use.");
  const scopedDependencies = async (extra) => {
    if (typeof resolveConversation !== "function") throw new Error("Computer Use requires a conversation authority resolver.");
    const resolved = await resolveConversation(extra);
    const ownerConversationId = String(resolved?.conversationId || "").trim();
    if (!ownerConversationId) throw new Error("Computer Use requires the current ChatGPT conversation identity.");
    return { capabilityRuntime, codexMcpBridge, ownerConversationId };
  };

  server.registerTool("codex_computer_use_status", {
    title: "Codex Computer Use status",
    description: "Read-only check of the installed OpenAI bundled Computer Use runtime. It initializes @oai/sky through the existing persistent Codex node_repl and performs no desktop input.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async (_, extra) => {
    try { return resultFromComputerUse(await codexComputerUseStatus(await scopedDependencies(extra))); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool("codex_computer_use", {
    title: "OpenAI Codex Computer Use",
    description: "Use automatically for Windows GUI work that requires seeing or operating a visible app. This is a thin adapter over the installed OpenAI bundled Computer Use runtime: persistent Codex node_repl imports @oai/sky, and all window discovery, screenshots, accessibility, clicks, typing, scrolling and dragging are executed by sky itself. DevSpace has no second GUI driver. Follow the official observe→decide→one action→re-observe workflow. Do not automate terminals, authentication/password/security UI, or ChatGPT/Codex app UI. Prefer Browser Use for ordinary browser automation.",
    inputSchema: {
      action: z.enum([
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
      ]),
      input: z.record(z.string(), z.unknown()).default({}),
      timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
    },
    annotations: EXECUTING,
  }, async ({ action, input = {}, timeoutMs = 30_000 }, extra) => {
    try {
      return resultFromComputerUse(await callCodexComputerUse(await scopedDependencies(extra), { action, input, timeoutMs }));
    } catch (error) {
      return errorResult(error);
    }
  });
}
