import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildElicitationRequest,
  currentTimeSnapshot,
  detectImageMime,
  loadWorkspaceImage,
  normalizeElicitationAnswers,
  registerCodexParityTools,
} from "./codex-parity-tools.js";
import { ToolCatalogRegistry, instrumentToolRegistration } from "./tool-catalog.js";

function pngBytes() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}

assert.equal(detectImageMime(pngBytes()), "image/png");
assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
assert.equal(detectImageMime(Buffer.from("GIF89a")), "image/gif");
assert.equal(detectImageMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "image/webp");
assert.equal(detectImageMime(Buffer.from("not-an-image")), null);

const questions = [{
  id: "release_mode",
  header: "Release",
  question: "Which release mode should be used?",
  options: [
    { label: "Canary", description: "Deploy to an isolated candidate first." },
    { label: "Production", description: "Deploy directly to production." },
  ],
}];
const elicitation = buildElicitationRequest(questions);
assert.equal(elicitation.mode, "form");
assert.deepEqual(elicitation.requestedSchema.required, ["release_mode"]);
assert.deepEqual(elicitation.requestedSchema.properties.release_mode.enum, ["Canary", "Production", "Other"]);
assert.throws(() => buildElicitationRequest([]), /one to three/);
assert.throws(() => buildElicitationRequest([{ ...questions[0], id: "Bad-ID" }]), /snake_case/);
assert.deepEqual(normalizeElicitationAnswers(questions, {
  action: "accept",
  content: { release_mode: "Other", release_mode_other: "Blue/green" },
}), {
  action: "accept",
  answers: { release_mode: { selected: "Other", otherText: "Blue/green" } },
});

const fixedTime = new Date("2026-09-07T03:04:05.000Z");
const utc = currentTimeSnapshot({ timeZone: "UTC", now: fixedTime });
assert.equal(utc.utcIso, "2026-09-07T03:04:05.000Z");
assert.equal(utc.localDate, "2026-09-07");
assert.equal(utc.localTime, "03:04:05");
assert.throws(() => currentTimeSnapshot({ timeZone: "Not/AZone", now: fixedTime }), /Invalid IANA/);

const root = await mkdtemp(join(tmpdir(), "devspace-view-image-"));
const outside = await mkdtemp(join(tmpdir(), "devspace-view-image-outside-"));
try {
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "assets", "image.bin"), pngBytes());
  await writeFile(join(root, "assets", "text.bin"), "not an image");
  await writeFile(join(outside, "outside.png"), pngBytes());
  const workspace = { id: "ws_test", root };
  const workspaces = {
    getWorkspace(id) {
      assert.equal(id, "ws_test");
      return workspace;
    },
    resolvePath(_workspace, value) {
      const normalized = String(value).replace(/\\/g, "/");
      if (normalized.startsWith("../") || normalized.includes("/../")) throw new Error("Path is outside workspace root");
      return join(root, normalized);
    },
  };
  const loaded = await loadWorkspaceImage({ workspaces, workspaceId: "ws_test", path: "assets/image.bin" });
  assert.equal(loaded.mimeType, "image/png");
  await assert.rejects(
    () => loadWorkspaceImage({ workspaces, workspaceId: "ws_test", path: "../outside.png" }),
    /outside workspace root/,
  );
  await assert.rejects(
    () => loadWorkspaceImage({ workspaces, workspaceId: "ws_test", path: "assets/text.bin" }),
    /Unsupported or invalid image/,
  );

  const handlers = new Map();
  const toolCatalog = new ToolCatalogRegistry();
  const server = {
    server: {
      async elicitInput(request) {
        assert.equal(request.requestedSchema.properties.release_mode.type, "string");
        return { action: "accept", content: { release_mode: "Canary" } };
      },
    },
    registerTool(name, definition, handler) {
      handlers.set(name, { definition, handler });
    },
  };
  instrumentToolRegistration(server, toolCatalog);
  const capabilityRuntime = {
    async search(query) {
      return query.includes("memory") ? [{ id: "powermem-shared", probedMcpToolNames: ["search_memories"] }] : [];
    },
  };
  const codexMcpBridge = {
    async search(query) {
      return query.includes("blender") ? [{ id: "blender_mcp", status: "not-probed" }] : [];
    },
  };
  const contextGuardian = {
    async status(runtimeKey) {
      assert.equal(runtimeKey, "main-01");
      return {
        conversationId: "conversation-a",
        currentModelSlug: "gpt-test",
        contextWindowTokens: 1000,
        hostMeasuredTokens: 999,
        hostUsageObservedAt: "2026-09-07T03:04:00.000Z",
      };
    },
  };
  const exactUsageAuthority = {
    async status({ conversationId }) {
      assert.equal(conversationId, "conversation-a");
      return {
        available: true,
        exactUsedTokens: 400,
        usageKind: "input_tokens",
        evidencePath: "event_12.usage.input_tokens",
        observedAt: "2026-09-07T03:04:00.000Z",
        source: "classic-native-protocol",
      };
    },
  };
  let slept = -1;
  registerCodexParityTools(server, {
    workspaces,
    capabilityRuntime,
    codexMcpBridge,
    contextGuardian,
    exactUsageAuthority,
    toolCatalog,
    sleep: async (ms) => { slept = ms; },
    now: () => fixedTime,
  });

  for (const required of ["view_image", "request_user_input", "current_time", "sleep", "get_context_remaining", "tool_search"]) {
    assert.ok(handlers.has(required), `missing parity tool ${required}`);
  }
  const imageResult = await handlers.get("view_image").handler({ workspaceId: "ws_test", path: "assets/image.bin" });
  assert.equal(imageResult.structuredContent.mimeType, "image/png");
  assert.equal(imageResult.content[1].type, "image");
  assert.equal(Buffer.from(imageResult.content[1].data, "base64").equals(pngBytes()), true);

  const inputResult = await handlers.get("request_user_input").handler({ questions });
  assert.equal(inputResult.structuredContent.supported, true);
  assert.equal(inputResult.structuredContent.answers.release_mode.selected, "Canary");

  const timeResult = await handlers.get("current_time").handler({ timeZone: "UTC" });
  assert.equal(timeResult.structuredContent.utcIso, fixedTime.toISOString());
  await handlers.get("sleep").handler({ seconds: 1.25, reason: "settle" });
  assert.equal(slept, 1250);

  const contextResult = await handlers.get("get_context_remaining").handler({ mainNumber: 1 });
  assert.equal(contextResult.structuredContent.available, true);
  assert.equal(contextResult.structuredContent.remainingTokens, 600);
  assert.equal(contextResult.structuredContent.usedTokens, 400, "legacy hostMeasuredTokens must not override exact authority");
  assert.equal(contextResult.structuredContent.source, "classic-native-protocol");
  assert.equal(contextResult.structuredContent.evidencePath, "event_12.usage.input_tokens");
  assert.equal(contextResult.structuredContent.estimatorFallbackUsed, false);

  const searchResult = await handlers.get("tool_search").handler({ query: "image", limit: 10, includeCapabilities: true });
  assert.equal(searchResult.structuredContent.coreTools.some((entry) => entry.name === "view_image"), true);
  const capabilitySearch = await handlers.get("tool_search").handler({ query: "memory", limit: 10, includeCapabilities: true });
  assert.equal(capabilitySearch.structuredContent.capabilities[0].id, "powermem-shared");
  const linkedSearch = await handlers.get("tool_search").handler({ query: "blender", limit: 10, includeCapabilities: true });
  assert.equal(linkedSearch.structuredContent.linkedCodexMcp[0].id, "blender_mcp");
  assert.equal(toolCatalog.diagnostics().names.includes("request_user_input"), true);

  const unsupportedHandlers = new Map();
  const unsupportedCatalog = new ToolCatalogRegistry();
  const unsupportedServer = {
    server: { async elicitInput() { throw new Error("Client does not support form elicitation."); } },
    registerTool(name, definition, handler) { unsupportedHandlers.set(name, { definition, handler }); },
  };
  instrumentToolRegistration(unsupportedServer, unsupportedCatalog);
  registerCodexParityTools(unsupportedServer, {
    workspaces,
    capabilityRuntime,
    codexMcpBridge,
    contextGuardian: { async status() { return { conversationId: "conversation-a", contextWindowTokens: 1000, hostMeasuredTokens: 999 }; } },
    exactUsageAuthority: { async status() { return { available: false, reason: "exact-native-token-field-not-exposed", source: "unavailable" }; } },
    toolCatalog: unsupportedCatalog,
  });
  const unsupported = await unsupportedHandlers.get("request_user_input").handler({ questions });
  assert.equal(unsupported.structuredContent.supported, false);
  const unavailableContext = await unsupportedHandlers.get("get_context_remaining").handler({ mainNumber: 1 });
  assert.equal(unavailableContext.structuredContent.available, false);
  assert.equal(unavailableContext.structuredContent.remainingTokens, null);
  assert.equal(unavailableContext.structuredContent.usedTokens, null);
  assert.equal(unavailableContext.structuredContent.reason, "exact-native-token-field-not-exposed");
  assert.equal(unavailableContext.structuredContent.estimatorFallbackUsed, false);

  console.log(JSON.stringify({
    ok: true,
    gate: "codex-parity-tools",
    viewImageWorkspaceConfined: true,
    formElicitationWithFallback: true,
    exactContextFailsClosed: true,
    currentTimeAndBoundedSleep: true,
    unifiedToolSearch: true,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
