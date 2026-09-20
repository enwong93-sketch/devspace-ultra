#!/usr/bin/env node
// Temporary authenticated read-only MCP anchor for otherwise-empty handovers.
// Never weakens the Gateway continuity gate; never kills or navigates a Main.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../dist/config.js';
import { loadDevspaceFiles } from '../dist/user-config.js';
import { atomicWriteJson } from '../dist/atomic-file.js';
import { waitForStableGatewayQuiet } from '../dist/stable-gateway-quiet.js';
import { readGatewayControlFile } from './devspace-stable-gateway.mjs';

const [mode, idArg] = process.argv.slice(2);
if (process.argv.length > (['--worker', '--status'].includes(mode) ? 4 : 3)) throw new Error('Unexpected handover arguments');
if (!['--execute', '--preflight-only', '--worker', '--status'].includes(mode)) {
  console.log('Usage: devspace-verified-handover.mjs --execute | --preflight-only | --status <id>');
  process.exit(mode ? 2 : 0);
}
if ((mode === '--worker' || mode === '--status') && !/^[a-f0-9-]{36}$/.test(idArg || '')) throw new Error('Valid operation id required');
const id = idArg || randomUUID();
const directory = join(tmpdir(), 'devspace-verified-handovers');
const path = join(directory, id + '.json');
if (mode === '--status') { console.log(await readFile(path, 'utf8')); process.exit(0); }
await mkdir(directory, { recursive: true });
if (mode === '--execute') {
  await atomicWriteJson(path, { id, phase: 'scheduled', rawCredentialsStored: false });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', id], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref(); console.log(JSON.stringify({ id, phase: 'scheduled', helperPid: child.pid, statusPath: path })); process.exit(0);
}

const state = { id, phase: 'authenticating-temporary-verifier', startedAt: new Date().toISOString(), rawCredentialsStored: false };
const save = async phase => { state.phase = phase; state.observedAt = new Date().toISOString(); await atomicWriteJson(path, state); };
await save(state.phase);
const config = loadConfig();
const files = loadDevspaceFiles();
const control = await readGatewayControlFile(files.dir);
const base = `http://127.0.0.1:${control.gatewayPort}`;
const resource = String(config.publicBaseUrl).replace(/\/$/, '') + '/mcp';
const redirectUri = 'http://127.0.0.1/devspace-handover-verifier';
let tokens = null, registration = null, client = null, transport = null;
async function jsonRequest(route, body, form = false, redirect = 'follow') {
  const response = await fetch(base + route, { method: 'POST', redirect,
    signal: AbortSignal.timeout(15000), headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form ? new URLSearchParams(body) : JSON.stringify(body) });
  if (redirect === 'manual') return response;
  if (!response.ok) { state.lastHttpStatus = response.status; throw new Error('local-authentication-request-failed'); }
  return response.json();
}
try {
  registration = await jsonRequest('/register', { client_name: 'DevSpace temporary handover verifier',
    redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  const verifier = randomBytes(32).toString('base64url');
  const nonce = randomUUID();
  const authorization = await jsonRequest('/authorize', { response_type: 'code', client_id: registration.client_id,
    redirect_uri: redirectUri, resource, scope: config.oauth.scopes[0], code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), state: nonce, owner_token: files.auth.ownerToken }, true, 'manual');
  if (authorization.status !== 302) { state.lastHttpStatus = authorization.status; throw new Error('owner-authorization-not-accepted'); }
  const callback = new URL(authorization.headers.get('location'));
  if (callback.origin + callback.pathname !== redirectUri || callback.searchParams.get('state') !== nonce) throw new Error('authorization-callback-mismatch');
  tokens = await jsonRequest('/token', { grant_type: 'authorization_code', client_id: registration.client_id,
    redirect_uri: redirectUri, resource, code: callback.searchParams.get('code'), code_verifier: verifier }, true);
  client = new Client({ name: 'devspace-maintenance-verifier', version: '0.5.8' }, { capabilities: {} });
  transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + tokens.access_token } } });
  await client.connect(transport);
  const before = await client.listTools();
  if (!before.tools.some(tool => tool.name === 'devspace_progress_report')) throw new Error('verifier-catalog-mismatch');
  const originalSessionId = transport.sessionId;
  state.toolCount = before.tools.length;
  await save('verification-anchor-ready');
  if (mode !== '--preflight-only') {
    const quiet = await waitForStableGatewayQuiet({ signal: AbortSignal.timeout(180000), consecutiveQuietSamples: 3,
      statusProbe: async () => {
        const r = await fetch(base + '/__devspace/gateway/status', { headers: { 'x-devspace-gateway-control': control.controlToken }, signal: AbortSignal.timeout(4000) });
        if (!r.ok) throw new Error('quiet-status-unavailable'); return r.json();
      } });
    if (!quiet.ok) throw new Error('quiet-boundary-not-reached');
    await save('handing-over');
    const response = await fetch(base + '/__devspace/gateway/handover', { method: 'POST', signal: AbortSignal.timeout(120000),
      headers: { 'content-type': 'application/json', 'x-devspace-gateway-control': control.controlToken }, body: JSON.stringify({ allowSchemaChange: false }) });
    const result = await response.json();
    state.handover = Object.fromEntries(['ok', 'state', 'activeSlot', 'activePid', 'candidateStage', 'schemaChanged',
      'requiresFreshInitialize', 'replayedSessions', 'deferredSessions', 'droppedSessions', 'replayFailureReasons', 'rollback', 'durationMs']
      .filter(key => result[key] !== undefined).map(key => [key, result[key]]));
    if (!response.ok || !result.ok) throw new Error('protected-handover-failed');
    const after = await client.listTools();
    state.sessionPreserved = transport.sessionId === originalSessionId;
    state.catalogPreserved = after.tools.length === before.tools.length;
    if (!state.sessionPreserved || !state.catalogPreserved) throw new Error('live-verifier-continuity-failed');
  }
  state.ok = true;
  await save(mode === '--preflight-only' ? 'preflight-verified' : 'handover-verified');
} catch (error) {
  state.ok = false; state.failurePhase = state.phase;
  state.errorType = error.name; state.reason = /^(local-|owner-|authorization-|verifier-|quiet-|protected-|live-)/.test(error.message) ? error.message : 'verifier-operation-failed';
  await save('failed');
} finally {
  let closed = !client;
  if (client) { try { await client.close(); closed = true; } catch {} }
  const revoked = [];
  for (const token of [tokens?.access_token, tokens?.refresh_token].filter(Boolean)) {
    try {
      const response = await fetch(base + '/revoke', { method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: registration.client_id, token }) });
      revoked.push(response.ok);
    } catch { revoked.push(false); }
  }
  state.verifierClosed = closed; state.temporaryTokensIssued = [tokens?.access_token, tokens?.refresh_token].filter(Boolean).length;
  state.temporaryTokensRevoked = revoked.every(Boolean);
  await save(state.phase); console.log(JSON.stringify(state));
}
process.exitCode = state.ok ? 0 : 1;
