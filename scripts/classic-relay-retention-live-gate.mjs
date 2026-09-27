#!/usr/bin/env node
import assert from "node:assert/strict";
import { ClassicCdpClient } from "../dist/classic-cdp-client.js";

const requested = process.argv.slice(2).map(Number).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
const ports = requested.length ? requested : [9732, 9733, 9734];
const rows = [];

for (const port of ports) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
    cache: "no-store",
    signal: AbortSignal.timeout(3_000),
  }).then((response) => response.json());
  const page = targets.find((target) => target?.type === "page" && /chatgpt\.com/i.test(target.url || "") && target.webSocketDebuggerUrl);
  assert.ok(page, `ChatGPT page target was not found on CDP port ${port}.`);
  const client = new ClassicCdpClient(page.webSocketDebuggerUrl, { callTimeoutMs: 8_000, maxPendingCalls: 4 });
  await client.open();
  try {
    const evaluated = await client.call("Runtime.evaluate", {
      expression: `(() => {
        const progressTitle = 'ui://devspace/progress-claim-relay.html';
        const goalTitle = 'ui://devspace/goal-continuation-relay.html';
        const root = document.getElementById('devspace-progress-narration-root');
        const composer = document.querySelector('#prompt-textarea');
        const visibleText = (document.body?.innerText || '').slice(-12000);
        const visibleButtons = [...document.querySelectorAll('button')].filter((button) => button.offsetParent !== null);
        const relay = document.querySelector('iframe[title="' + progressTitle + '"]');
        const structure = [];
        for (let node = relay, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) {
          structure.push({
            tag: node.tagName,
            attributes: [...node.attributes].map((attribute) => ({ name: attribute.name, value: attribute.value })),
          });
        }
        return {
          href: location.href,
          progressRelayFrames: document.querySelectorAll('iframe[title="' + progressTitle + '"]').length,
          goalRelayFrames: document.querySelectorAll('iframe[title="' + goalTitle + '"]').length,
          progressMessages: Array.isArray(root?.__devspaceProgressMessages) ? root.__devspaceProgressMessages.length : 0,
          overlayVersion: root?.dataset.uiVersion || null,
          domNodes: document.getElementsByTagName('*').length,
          heapUsed: Number(performance?.memory?.usedJSHeapSize || 0),
          composerTextLength: String(composer?.innerText || composer?.textContent || '').trim().length,
          generating: visibleButtons.some((button) => /停止|stop generating|stop response/i.test((button.innerText || button.textContent || button.getAttribute('aria-label') || '').trim())),
          stopButtonLabels: visibleButtons.map((button) => (button.innerText || button.textContent || button.getAttribute('aria-label') || '').trim()).filter((text) => /停止|stop generating|stop response/i.test(text)).slice(0, 5),
          deliveryTimeoutVisible: /訊息遞送逾時|message delivery timed out/i.test(visibleText),
          conversationTooLongVisible: /conversation is too long|對話.{0,12}太長/i.test(visibleText),
          relayStructure: structure,
        };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (evaluated?.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || `Runtime.evaluate failed on ${port}.`);
    const value = evaluated?.result?.value || {};
    rows.push({
      port,
      targetCount: targets.length,
      iframeTargets: targets.filter((target) => target?.type === "iframe").length,
      ...value,
    });
  } finally {
    client.close();
  }
}

console.log(JSON.stringify({ ok: true, gate: "classic-relay-retention-live", rows }, null, 2));
for (const row of rows) {
  assert.ok(row.progressRelayFrames <= 8, `Main on ${row.port} retained ${row.progressRelayFrames} progress relay frames.`);
  assert.ok(row.goalRelayFrames <= 4, `Main on ${row.port} retained ${row.goalRelayFrames} Goal relay frames.`);
}
