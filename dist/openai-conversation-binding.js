import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from './atomic-file.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' && value.length >= 1 && value.length <= 2048 ? value : null;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const conversation = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(value);
export const OPENAI_CONVERSATION_PAGE_SOURCE = 'openai-conversation-binding-page-verified';

/** openai/session is a provider-anonymized CONVERSATION id, not mcp-session-id.
 * Ref: https://developers.openai.com/plugins/reference#client-provided-_meta-fields
 * OAuth and resource checks must already have succeeded. Metadata is routing
 * context, not an authentication substitute; no URL owner is inferred from it.
 */
export function openaiConversationIdentity({ auth, meta = {}, headers = {} } = {}) {
  const resource = text(String(auth?.resource || ''));
  const client = text(auth?.clientId);
  const id = text(meta['openai/session']);
  const subject = text(meta['openai/subject']);
  const organization = meta['openai/organization'] == null ? '' : text(meta['openai/organization']);
  if (!resource || !client || !id || !subject || organization === null) return null;
  const h = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  for (const [key, value] of [['x-openai-session', id], ['x-openai-subject', subject]]) {
    if (h[key] != null && h[key] !== value) return null;
  }
  return { version: 1, key: hash(JSON.stringify(['openai-conversation-v1', resource, client, subject, organization, id])) };
}
export function cleanOpenaiIdentity(value) {
  return value?.version === 1 && hex(value.key) ? { version: 1, key: value.key } : null;
}

export function localBindingAuthorized(req, ownerToken) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req?.socket?.remoteAddress)) return false;
  if (req.headers?.origin || req.headers?.['sec-fetch-site'] || req.headers?.['x-forwarded-for']) return false;
  const expected = text(ownerToken), supplied = text(req.headers?.['x-devspace-owner-token']);
  return Boolean(expected && supplied && Buffer.byteLength(expected) === Buffer.byteLength(supplied)
    && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)));
}

export async function inspectExactConversationPage(runtimeKey, conversationId, fetchImpl = fetch) {
  if (!/^main-(0[1-9]|[12][0-9]|3[0-2])$/.test(runtimeKey || '') || !conversation(conversationId)) return null;
  const number = Number(runtimeKey.slice(-2));
  const port = number === 1 ? 9721 : 9730 + number;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000), cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    if (!Array.isArray(data)) return null;
    const matches = data.filter(page => {
      if (page?.type !== 'page') return false;
      try { const url = new URL(page.url); return url.protocol === 'https:' && url.hostname === 'chatgpt.com'
        && url.pathname.match(/\/c\/([^/?#]+)/)?.[1] === conversationId; } catch { return false; }
    });
    if (matches.length !== 1) return null;
    return { conversationId, runtimeKey, pageVerified: true, pageTargetId: matches[0].id,
      observedAt: new Date().toISOString(), source: OPENAI_CONVERSATION_PAGE_SOURCE };
  } catch { return null; }
}

/** Store only explicit URL bindings proved by a receipt or an owner-authorized
 * local bootstrap. A conflicting binding is quarantined, never silently moved.
 * Every reuse requires a fresh live page check. It is independent of transport
 * sessions, survives reconnects, and cannot be seeded from legacy session maps.
 */
export class OpenaiConversationBindings {
  constructor({ statePath = null, inspect = inspectExactConversationPage, maxBindings = 2048 } = {}) {
    this.statePath = statePath; this.inspect = inspect; this.maxBindings = maxBindings;
    this.records = new Map(); this.queue = Promise.resolve(); this.loadError = null;
    this.ready = this.load();
  }
  async load() {
    if (!this.statePath) return;
    try {
      const data = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.bindings) || data.bindings.length > this.maxBindings) throw new Error('Invalid binding store');
      for (const row of data.bindings) {
        if (!hex(row.key) || !conversation(row.conversationId) || !Array.isArray(row.runtimes)
          || !row.runtimes.length || row.runtimes.some(r => !/^main-(0[1-9]|[12][0-9]|3[0-2])$/.test(r))) throw new Error('Invalid binding row');
        this.records.set(row.key, row);
      }
    } catch (error) { if (error.code !== 'ENOENT') { this.records.clear(); this.loadError = 'invalid-provider-binding-store'; } }
  }
  async save() {
    if (!this.statePath) return;
    const data = { version: 1, bindings: [...this.records.values()].map(x => structuredClone(x)) };
    const next = this.queue.catch(() => {}).then(() => atomicWriteJson(this.statePath, data));
    this.queue = next; await next;
  }
  async bind(identity, proof, { operator = false } = {}) {
    await this.ready;
    const id = cleanOpenaiIdentity(identity);
    if (this.loadError || !id || !conversation(proof?.conversationId) || proof?.pageVerified !== true) return null;
    if (!operator && proof?.source !== 'classic-exact-page-progress-claim-cdp-page-verified') return null;
    if (operator && proof?.source !== OPENAI_CONVERSATION_PAGE_SOURCE) return null;
    const live = await this.inspect(proof.runtimeKey, proof.conversationId);
    if (!live?.pageVerified || live.conversationId !== proof.conversationId) return null;
    let existing = this.records.get(id.key);
    if (existing?.conflicted || (existing && existing.conversationId !== proof.conversationId)) {
      if (existing) { existing.conflicted = true; await this.save(); }
      return null;
    }
    if (!existing && this.records.size >= this.maxBindings) return null;
    existing ??= { key: id.key, conversationId: proof.conversationId, runtimes: [], boundAt: new Date().toISOString(), conflicted: false };
    existing.runtimes = [...new Set([...existing.runtimes, proof.runtimeKey])];
    existing.provenance = operator ? 'owner-authorized-exact-page-bootstrap' : 'authenticated-receipt-exact-page';
    this.records.set(id.key, existing); await this.save();
    return { bound: true, conversationId: existing.conversationId };
  }
  async resolve(identity) {
    await this.ready;
    const id = cleanOpenaiIdentity(identity);
    if (this.loadError || !id) return null;
    const row = this.records.get(id.key);
    if (!row || row.conflicted) return null;
    const checked = await Promise.all(row.runtimes.map(runtime => this.inspect(runtime, row.conversationId)));
    if (this.records.get(id.key) !== row || row.conflicted) return null;
    const live = checked.find(p => p?.pageVerified === true && p.conversationId === row.conversationId);
    return live ? { ...live, source: OPENAI_CONVERSATION_PAGE_SOURCE, providerConversationKey: id.key } : null;
  }
  status() { return { bindings: this.records.size, conflicted: [...this.records.values()].filter(x => x.conflicted).length,
    loadError: this.loadError, transportSessionOwnership: false, rawMetadataPersisted: false }; }
}
