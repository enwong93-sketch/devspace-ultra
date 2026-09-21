#!/usr/bin/env node
// Read-only model-surface diagnostic. Starts one passive candidate snapshot,
// returns hashes/field names only, and revokes its temporary OAuth tokens.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { loadConfig } from '../dist/config.js';
import { loadDevspaceFiles } from '../dist/user-config.js';
import { schemaFingerprint } from '../dist/stable-gateway-candidate.js';
import { createCandidateSnapshot, startCoreSlot, stopCoreSlot } from './devspace-core-slot.mjs';
import { readGatewayControlFile } from './devspace-stable-gateway.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
const summaryOnly = process.argv.includes('--summary');
const requestedDetails = new Set(process.argv.slice(2)
  .filter(value => value !== '--summary' && /^[A-Za-z0-9_.:-]{1,180}$/.test(value)));
function normalizeEquivalentSchema(value) {
  if (Array.isArray(value)) return value.map(normalizeEquivalentSchema);
  if (!value || typeof value !== 'object') return value;
  const normalized = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeEquivalentSchema(child)]));
  if (Array.isArray(normalized.type)) normalized.type = [...new Set(normalized.type)].sort();
  if (Array.isArray(normalized.anyOf)) {
    const simpleTypes = normalized.anyOf.map(branch => {
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) return null;
      const keys = Object.keys(branch);
      return keys.length === 1 && typeof branch.type === 'string' ? branch.type : null;
    });
    if (simpleTypes.every(Boolean)) {
      normalized.type = [...new Set(simpleTypes)].sort();
      delete normalized.anyOf;
    }
  }
  return normalized;
}
const parsePayload = text => {
  try { return JSON.parse(text); } catch {}
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try { return JSON.parse(line.slice(5).trim()); } catch {}
  }
  return null;
};
async function post(base, token, body, sessionId = null, protocol = null) {
  const response = await fetch(base + '/mcp', { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
      'content-type': 'application/json', ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(protocol ? { 'mcp-protocol-version': protocol } : {}) }, body: JSON.stringify(body) });
  const payload = parsePayload(await response.text());
  return { response, payload };
}
async function readTools(base, token) {
  const initialized = await post(base, token, { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'devspace-schema-diff', version: '0.5.8' } } });
  const sessionId = initialized.response.headers.get('mcp-session-id');
  const protocol = initialized.payload?.result?.protocolVersion || '2025-11-25';
  if (!initialized.response.ok || !sessionId) throw new Error(`initialize-${initialized.response.status}`);
  const notified = await post(base, token, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, sessionId, protocol);
  if (!notified.response.ok) throw new Error(`initialized-${notified.response.status}`);
  const listed = await post(base, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId, protocol);
  if (!listed.response.ok || !Array.isArray(listed.payload?.result?.tools)) throw new Error(`tools-list-${listed.response.status}`);
  return listed.payload.result.tools;
}
async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
function fieldSummary(tool) {
  const values = { title: tool?.title ?? '', description: tool?.description ?? '', inputSchema: tool?.inputSchema ?? null,
    outputSchema: tool?.outputSchema ?? null, annotations: tool?.annotations ?? null, _meta: tool?._meta ?? null };
  return Object.fromEntries(Object.entries(values).map(([field, value]) => [field, {
    sha256: hash(value), ...(typeof value === 'string' ? { chars: value.length } : {}) } ]));
}
const config = loadConfig();
const files = loadDevspaceFiles();
const control = await readGatewayControlFile(files.dir);
const gatewayBase = `http://127.0.0.1:${control.gatewayPort}`;
const status = await fetch(gatewayBase + '/__devspace/gateway/status', { signal: AbortSignal.timeout(4000),
  headers: { 'x-devspace-gateway-control': control.controlToken } }).then(r => r.json());
const coreAPort = Number(config.stableGatewayCoreAPort ?? control.gatewayPort + 10);
const coreBPort = Number(config.stableGatewayCoreBPort ?? control.gatewayPort + 11);
const activePort = status.activeSlot === 'b' ? coreBPort : coreAPort;
if (!Number.isInteger(activePort)) throw new Error('active-core-port-unavailable');
const resource = String(config.publicBaseUrl).replace(/\/$/, '') + '/mcp';
const redirectUri = 'http://127.0.0.1/devspace-schema-diff';
let registration, tokens, snapshot, candidate;
try {
  registration = await fetch(gatewayBase + '/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'DevSpace schema diff', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) }).then(r => r.json());
  const verifier = randomBytes(32).toString('base64url'); const nonce = randomUUID();
  const authorization = await fetch(gatewayBase + '/authorize', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ response_type: 'code',
      client_id: registration.client_id, redirect_uri: redirectUri, resource, scope: config.oauth.scopes[0],
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      state: nonce, owner_token: files.auth.ownerToken }) });
  const callback = new URL(authorization.headers.get('location'));
  tokens = await fetch(gatewayBase + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registration.client_id, redirect_uri: redirectUri,
      resource, code: callback.searchParams.get('code'), code_verifier: verifier }) }).then(r => r.json());
  const active = await readTools(`http://127.0.0.1:${activePort}`, tokens.access_token);
  snapshot = await createCandidateSnapshot({ sourceStateDir: config.stateDir });
  candidate = await startCoreSlot({ id: 'schema-diff', port: await reservePort(), configDir: files.dir,
    stateDir: snapshot.stateDir, publicBaseUrl: config.publicBaseUrl, candidate: true });
  const next = await readTools(candidate.baseUrl, tokens.access_token);
  const left = new Map(active.map(tool => [tool.name, tool])); const right = new Map(next.map(tool => [tool.name, tool]));
  const changed = [];
  const nonEquivalentTools = [];
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    if (!left.has(name)) { changed.push({ name, change: 'added' }); continue; }
    if (!right.has(name)) { changed.push({ name, change: 'removed' }); continue; }
    const a = fieldSummary(left.get(name)); const b = fieldSummary(right.get(name));
    const fields = Object.keys(a).filter(field => a[field].sha256 !== b[field].sha256);
    if (fields.length) {
      changed.push({ name, change: 'modified', fields,
        before: Object.fromEntries(fields.map(field => [field, a[field]])), after: Object.fromEntries(fields.map(field => [field, b[field]])) });
      const equivalent = fields.every(field => hash(normalizeEquivalentSchema(left.get(name)?.[field]))
        === hash(normalizeEquivalentSchema(right.get(name)?.[field])));
      if (!equivalent) nonEquivalentTools.push(name);
    }
  }
  const report = { ok: true, activeSlot: status.activeSlot, activePort, activeToolCount: active.length,
    candidateToolCount: next.length, activeFingerprint: schemaFingerprint(active), candidateFingerprint: schemaFingerprint(next),
    changedToolCount: changed.length, changed, semanticEquivalent: nonEquivalentTools.length === 0,
    nonEquivalentTools,
    details: Object.fromEntries([...requestedDetails].map(name => [name, {
      before: left.has(name) ? { inputSchema: left.get(name).inputSchema, outputSchema: left.get(name).outputSchema } : null,
      after: right.has(name) ? { inputSchema: right.get(name).inputSchema, outputSchema: right.get(name).outputSchema } : null,
    }])),
    rawDescriptionsReturned: false, detailedSchemasRequested: requestedDetails.size > 0 };
  if (summaryOnly) delete report.changed;
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (candidate) await stopCoreSlot(candidate).catch(() => {});
  if (snapshot) await snapshot.cleanup().catch(() => {});
  for (const token of [tokens?.access_token, tokens?.refresh_token].filter(Boolean)) {
    await fetch(gatewayBase + '/revoke', { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: registration.client_id, token }) }).catch(() => {});
  }
}
