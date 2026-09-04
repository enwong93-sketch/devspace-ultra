import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { createCodexContextBridge } from "./codex-context-bridge.js";

const root = mkdtempSync(join(tmpdir(), "devspace-context-bridge-"));
const codexDir = join(root, ".codex");
const devspaceStateDir = join(root, "devspace-state");
mkdirSync(codexDir, { recursive: true });

const stateDbPath = join(codexDir, "state_5.sqlite");
const stateDb = new Database(stateDbPath);
stateDb.exec(`
  create table threads (
    id text primary key,
    rollout_path text not null,
    created_at integer not null,
    updated_at integer not null,
    source text not null,
    model_provider text not null,
    cwd text not null,
    title text not null,
    sandbox_policy text not null,
    approval_mode text not null,
    tokens_used integer not null default 0,
    has_user_event integer not null default 0,
    archived integer not null default 0,
    archived_at integer,
    project_id text,
    model text,
    reasoning_effort text,
    first_user_message text not null default '',
    preview text not null default '',
    name text,
    updated_at_ms integer,
    created_at_ms integer
  );
`);

function rolloutPath(id) {
  return join(codexDir, "sessions", `${id}.jsonl`);
}
function writeRollout(id, records) {
  const file = rolloutPath(id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return file;
}
function responseMessage(role, text, extraContent = []) {
  return {
    timestamp: new Date().toISOString(),
    type: "response_item",
    payload: {
      type: "message",
      id: `msg-${Math.random()}`,
      role,
      content: [
        { type: role === "assistant" ? "output_text" : "input_text", text },
        ...extraContent,
      ],
    },
  };
}

const alphaRollout = writeRollout("thread-alpha", [
  { type: "session_meta", payload: { cwd: "C:\\Projects\\H3", base_instructions: "do not import this developer state" } },
  responseMessage("developer", "SECRET-DEVELOPER-INSTRUCTION"),
  responseMessage("user", "Old goal before compaction"),
  responseMessage("assistant", "Old assistant answer before compaction"),
  { type: "response_item", payload: { type: "reasoning", summary: [{ text: "SECRET-CHAIN-OF-THOUGHT" }], encrypted_content: "cipher" } },
  { type: "response_item", payload: { type: "function_call", name: "bash", arguments: "{\"command\":\"echo SECRET-TOOL-ARG\"}" } },
  { type: "response_item", payload: { type: "function_call_output", output: "SECRET-TOOL-OUTPUT" } },
  { type: "compacted", payload: { message: "Decision summary: keep the H3 pipeline. api_key=sk-test-1234567890abcdef should not survive.", replacement_history: [] } },
  responseMessage("user", "Continue after compaction", [{ type: "input_image", image_url: "data:image/png;base64,SECRETIMAGE", detail: "high" }]),
  responseMessage("assistant", "Implemented the next safe change."),
  responseMessage("user", "<codex_internal_context source=\"goal\">SECRET-INTERNAL-GOAL</codex_internal_context>"),
  responseMessage("user", "<codex_delegation>SECRET-DELEGATION-CONTROL</codex_delegation>"),
  responseMessage("user", "# Response annotations:\nSECRET-RESPONSE-ANNOTATION-CONTROL"),
  { type: "event_msg", payload: { type: "agent_reasoning", text: "SECRET-EVENT-REASONING" } },
  responseMessage("user", "Final request Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"),
  responseMessage("assistant", "Final answer points to src/h3.js and tests/h3.test.js."),
]);
const betaRollout = writeRollout("thread-beta", [
  responseMessage("user", "Beta first"),
  responseMessage("assistant", "Beta response"),
]);
const archivedRollout = writeRollout("thread-archived", [
  responseMessage("user", "Archived context"),
  responseMessage("assistant", "Archived response"),
]);

const insertThread = stateDb.prepare(`
  insert into threads (
    id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
    sandbox_policy, approval_mode, archived, project_id, model, reasoning_effort,
    first_user_message, preview, name, updated_at_ms, created_at_ms
  ) values (@id,@rollout_path,1,@updated,'cli','openai',@cwd,@title,'workspace-write','never',@archived,null,@model,'medium',@first,@preview,null,@updated,1)
`);
insertThread.run({ id: "thread-alpha", rollout_path: alphaRollout, updated: 3000, cwd: "C:\\Projects\\H3", title: "Fix H3 Pipeline", archived: 0, model: "gpt-test", first: "Old goal", preview: "H3 preview" });
insertThread.run({ id: "thread-beta", rollout_path: betaRollout, updated: 2000, cwd: "C:\\Projects\\H3\\experiments", title: "Fix H3 Pipeline alternate", archived: 0, model: "gpt-test", first: "Beta", preview: "Beta preview" });
insertThread.run({ id: "thread-archived", rollout_path: archivedRollout, updated: 1000, cwd: "C:\\Projects\\Old", title: "Archived H3", archived: 1, model: "gpt-old", first: "Archived", preview: "Archived preview" });
stateDb.close();

const bridge = createCodexContextBridge({ codexDir, stateDir: devspaceStateDir });

try {
  const defaultList = bridge.listThreads({ limit: 20 });
  assert.deepEqual(defaultList.map((thread) => thread.id), ["thread-alpha", "thread-beta"]);
  assert.equal(defaultList.some((thread) => thread.rolloutPath), false, "public selector metadata should not expose local rollout paths by default");

  const projectList = bridge.listThreads({ projectPath: "C:\\Projects\\H3", limit: 20 });
  assert.deepEqual(projectList.map((thread) => thread.id), ["thread-alpha", "thread-beta"]);

  const archived = bridge.listThreads({ includeArchived: true, query: "Archived", limit: 20 });
  assert.equal(archived[0].id, "thread-archived");

  const ambiguous = bridge.resolveThread({ query: "Fix H3", projectPath: "C:\\Projects\\H3" });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, "ambiguous");
  assert.equal(ambiguous.candidates.length, 2);

  const latest = bridge.resolveThread({ projectPath: "C:\\Projects\\H3", latest: true });
  assert.equal(latest.ok, true);
  assert.equal(latest.thread.id, "thread-alpha");

  const imported = await bridge.importThread({
    threadId: "thread-alpha",
    maxChars: 5000,
    maxMessages: 20,
    maxMessageChars: 1000,
    persist: true,
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.threadId, "thread-alpha");
  assert.equal(imported.usedCodexCompaction, true);
  assert.equal(imported.sourceMode, "rollout-stream");
  assert.match(imported.contextText, /Imported Codex Context/);
  assert.match(imported.contextText, /Decision summary: keep the H3 pipeline/);
  assert.match(imported.contextText, /Continue after compaction/);
  assert.match(imported.contextText, /Implemented the next safe change/);
  assert.match(imported.contextText, /Final answer points to src\/h3\.js/);
  assert.match(imported.contextText, /\[image omitted from ContextBridge\]/);
  assert.match(imported.contextText, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(imported.contextText, /sk-test-1234567890abcdef/);
  assert.doesNotMatch(imported.contextText, /abcdefghijklmnopqrstuvwxyz012345/);
  assert.doesNotMatch(imported.contextText, /SECRET-DEVELOPER-INSTRUCTION|SECRET-CHAIN-OF-THOUGHT|SECRET-TOOL-ARG|SECRET-TOOL-OUTPUT|SECRET-EVENT-REASONING|SECRET-INTERNAL-GOAL|SECRET-DELEGATION-CONTROL|SECRET-RESPONSE-ANNOTATION-CONTROL/);
  assert.doesNotMatch(imported.contextText, /Old goal before compaction|Old assistant answer before compaction/);
  assert.ok(imported.redactionsApplied >= 2);
  assert.ok(imported.capsuleId);

  const persisted = bridge.readCapsule({ capsuleId: imported.capsuleId });
  assert.equal(persisted.ok, true);
  assert.equal(persisted.threadId, "thread-alpha");
  assert.equal(persisted.contextText, imported.contextText);
  const persistedRaw = readFileSync(persisted.path, "utf8");
  assert.doesNotMatch(persistedRaw, /SECRET-|sk-test-|abcdefghijklmnopqrstuvwxyz012345/);

  const tiny = await bridge.importThread({ threadId: "thread-alpha", maxChars: 700, maxMessages: 2, maxMessageChars: 300, persist: false });
  assert.equal(tiny.ok, true);
  assert.ok(tiny.contextText.length <= 900, "format overhead may exceed maxChars slightly but must remain bounded");
  assert.equal(tiny.truncated, true);
  assert.ok(tiny.messagesIncluded <= 2);

  console.log(JSON.stringify({ ok: true, gate: "codex-context-bridge", tests: 9 }));
} finally {
  bridge.close();
  rmSync(root, { recursive: true, force: true });
}
