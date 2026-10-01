import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./chat-swarm-classic-cdp-bootstrap.mjs', import.meta.url), 'utf8');
function expression(name, next) {
  const start = source.indexOf(`function ${name}() {`), end = source.indexOf(`function ${next}`, start + 1);
  assert.ok(start >= 0 && end > start, `missing ${name} expression`);
  return runInNewContext(`${source.slice(start, end)}\n${name}()`);
}
const probe = expression('expressionForProbe', 'compactProbe');
const dismiss = expression('expressionForDismissThrottle', 'expressionForNewChat');
function node(text = '', buttons = []) {
  return { innerText: text, textContent: text, offsetParent: {}, disabled: false,
    getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 100, height: 30 }),
    getAttribute: () => null, querySelectorAll: selector => selector === 'button' ? buttons : [] };
}
function fixture({ bodyText = '', dialogs = [], alerts = [] } = {}) {
  const composer = { ...node(''), value: '' };
  const document = { title: 'ChatGPT', readyState: 'complete', body: { innerText: bodyText },
    querySelector: selector => selector === '#prompt-textarea' ? composer : null,
    querySelectorAll: selector => {
      if (selector === '[role="dialog"],[role="alertdialog"]') return dialogs;
      if (selector === '[role="alert"],[data-sonner-toast]') return alerts;
      return [];
    } };
  return { document, location: { href: 'https://chatgpt.com/c/fixture' } };
}
function run(code, world) { return runInNewContext(code, world); }

test('historical rate-limit text is not a current notice and cannot dismiss another dialog', () => {
  let clicks = 0;
  const close = { ...node('關閉'), click: () => { clicks++; } };
  const promo = { ...node('認識全新 ChatGPT', [close]) };
  const world = fixture({ bodyText: 'The old conversation quoted: try again later.', dialogs: [promo] });
  assert.equal(run(probe, world).throttled, false);
  assert.equal(run(dismiss, world).clicked, false);
  assert.equal(clicks, 0);
});

test('one visible rate-limit dialog is detected and its exact acknowledgement is clicked once', () => {
  let clicks = 0;
  const ack = { ...node('知道了'), click: () => { clicks++; } };
  const notice = { ...node('太多要求\n請稍等幾分鐘後再試', [ack]) };
  const world = fixture({ dialogs: [notice] });
  assert.equal(run(probe, world).throttled, true);
  assert.equal(run(dismiss, world).clicked, true);
  assert.equal(clicks, 1);
});

test('ambiguous dialogs never trigger an acknowledgement click', () => {
  let clicks = 0;
  const ack = { ...node('知道了'), click: () => { clicks++; } };
  const notice = { ...node('Too many requests\nPlease wait a few minutes', [ack]) };
  const world = fixture({ dialogs: [notice, node('Other dialog')] });
  assert.equal(run(probe, world).throttled, false);
  assert.equal(run(dismiss, world).clicked, false);
  assert.equal(clicks, 0);
});
