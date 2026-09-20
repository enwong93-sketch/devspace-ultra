import assert from 'node:assert/strict';
import { summarizeContextPayload } from './context-payload-audit.js';
const payload = { current_node: 't2', mapping: {
  u: { parent: null, message: { author: { role: 'user' }, content: { parts: ['Continue'] } } },
  call: { parent: 'u', message: { author: { role: 'assistant' }, recipient: 'api_tool.call_tool', content: { parts: [JSON.stringify({ path: '/repo/fetch_file', args: { path: 'private.js' } })] } } },
  t1: { parent: 'call', message: { author: { role: 'tool' }, content: { parts: ['x'.repeat(16000)] } } },
  t2: { parent: 't1', message: { author: { role: 'tool' }, content: { parts: ['x'.repeat(16000)] } } },
  off: { parent: 'u', message: { author: { role: 'user' }, content: { parts: ['off branch'] } } },
} };
const result = summarizeContextPayload(payload);
assert.equal(result.groups.user.messages, 1);
assert.equal(result.groups.toolResults.textBytes, 32000);
assert.equal(result.repeatedTextBytes, 16000);
assert.equal(result.offBranchNodes, 1);
assert.equal(result.byPrecedingTool[0].tool, 'fetch_file');
assert.equal(result.nativeTokens, null);
assert.equal(JSON.stringify(result).includes('private.js'), false);
assert.equal(JSON.stringify(result).includes('xxxx'), false);
assert.equal(summarizeContextPayload({}).ok, false);
payload.mapping.t2.message = { author: { role: 'assistant' }, channel: 'analysis', content: { parts: ['not exported'] } };
assert.equal(summarizeContextPayload(payload).excludedReasoningMessages, 1);
assert.equal(JSON.stringify(summarizeContextPayload(payload)).includes('not exported'), false);
console.log(JSON.stringify({ ok: true, gate: 'context-payload-audit', rawContentReturned: false, bytesNotTokens: true, activeBranchOnly: true }));
