import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const server = await readFile(resolve(root, "dist/server.js"), "utf8");
const runtime = await readFile(resolve(root, "dist/context-guardian.js"), "utf8");
const cdp = await readFile(resolve(root, "dist/context-guardian-cdp.js"), "utf8");

assert.match(server, /ContextGuardianRuntime/, "server must create the Context Guardian runtime");
assert.match(server, /ClassicContextMetadataCdpAdapter/, "server must create the Classic native metadata observer");
assert.match(server, /observeNativeModelCatalog/, "native Classic model catalog events must feed Context Guardian");
assert.match(server, /observeTurnRequest/, "native outbound turn model metadata must feed Context Guardian");
assert.match(server, /observeRuntimeSnapshot/, "Classic DOM model snapshots must seed Context Guardian");
assert.match(server, /registerContextGuardianTools/, "every MCP server must expose read-only Context Guardian status");
assert.match(server, /contextGuardian\.close\(\)/, "Context Guardian runtime must close during backend shutdown");
assert.match(server, /contextMetadataAdapter\.close\(\)/, "Context metadata CDP observer must close during backend shutdown");
assert.match(runtime, /context_guardian_status/, "Context Guardian must expose one read-only status tool");
assert.doesNotMatch(cdp, /authorization\s*:/i, "Context Guardian observer must not persist or construct authorization headers");
assert.doesNotMatch(cdp, /cookie\s*:/i, "Context Guardian observer must not persist or construct cookies");
assert.doesNotMatch(cdp, /conduit_token|resume_conversation_token/i, "Context Guardian observer must not persist transient ChatGPT transport tokens");

console.log(JSON.stringify({ ok: true, gate: "context-guardian-static", nativeCatalog: true, safeMetadataOnly: true }));
