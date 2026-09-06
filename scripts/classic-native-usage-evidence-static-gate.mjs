import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cdp = await readFile(new URL("../dist/context-guardian-cdp.js", import.meta.url), "utf8");
const evidence = await readFile(new URL("../dist/classic-native-usage-evidence.js", import.meta.url), "utf8");
const server = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");

assert.match(cdp, /Network\.requestWillBeSentExtraInfo/, "native usage evidence should inspect final request headers without relying on renderer state");
assert.match(cdp, /Network\.responseReceivedExtraInfo/, "native usage evidence should inspect final response headers");
assert.match(cdp, /Network\.getResponseBody/, "completed native turn responses may be parsed in memory for numeric usage evidence");
assert.match(cdp, /TURN_USAGE_MAX_BODY_BYTES/, "native usage evidence body inspection must have an explicit size bound");
assert.match(cdp, /extractClassicNativeUsageEvidence/, "raw native response content must be reduced to safe numeric evidence before leaving the CDP adapter");
assert.match(server, /new ClassicNativeUsageEvidenceStore\([\s\S]*classic-native-usage-evidence\.json/, "safe native usage evidence must persist independently from estimator-based Context Guardian state");
assert.match(server, /onUsageEvidence:[\s\S]*nativeUsageEvidence\.record\(event\)/, "server must persist only reduced usage evidence emitted by the CDP adapter");
assert.doesNotMatch(evidence, /authorization.*writeFile|cookie.*writeFile|responseBody.*writeFile/i, "raw credentials or response bodies must never be written to the evidence file");
assert.match(evidence, /MAX_CANDIDATES\s*=\s*256/, "numeric usage candidates must be bounded");

console.log(JSON.stringify({
  ok: true,
  gate: "classic-native-usage-evidence-static",
  nativeProtocolOnly: true,
  bounded: true,
  rawContentPersisted: false,
}));
