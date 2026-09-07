#!/usr/bin/env node
import assert from "node:assert/strict";
import { ClassicCdpClient } from "../dist/classic-cdp-client.js";

const port = Math.max(1, Math.min(65535, Number(process.argv[2] || 9732)));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
  cache: "no-store",
  signal: AbortSignal.timeout(3_000),
}).then((response) => response.json());
const page = Array.isArray(targets)
  ? targets.find((item) => item?.type === "page" && /chatgpt\.com/i.test(item.url || "") && item.webSocketDebuggerUrl)
  : null;
assert.ok(page, `ChatGPT page target was not found on CDP port ${port}.`);

const client = new ClassicCdpClient(page.webSocketDebuggerUrl, {
  callTimeoutMs: 8_000,
  maxPendingCalls: 4,
});

async function evaluate(expression) {
  const response = await client.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response?.exceptionDetails) throw new Error(response.exceptionDetails.text || "Runtime.evaluate failed.");
  return response?.result?.value;
}

const stateExpression = `(() => {
  const root = document.getElementById('devspace-progress-narration-root');
  const scroll = root?.querySelector('.devspace-progress-scroll');
  const goal = document.querySelector('#devspace-host-overlay-root .devspace-goal-strip[data-visible="true"]');
  const form = document.querySelector('#prompt-textarea')?.closest('form');
  const rootRect = root?.getBoundingClientRect();
  const goalRect = goal?.getBoundingClientRect();
  const formRect = form?.getBoundingClientRect();
  return {
    uiVersion: root?.dataset.uiVersion || null,
    size: root?.dataset.size || null,
    controls: root?.querySelectorAll('.devspace-progress-button').length || 0,
    rendered: root?.querySelectorAll('.devspace-progress-message').length || 0,
    messageCount: Array.isArray(root?.__devspaceProgressMessages) ? root.__devspaceProgressMessages.length : 0,
    scrollTop: scroll?.scrollTop || 0,
    scrollHeight: scroll?.scrollHeight || 0,
    clientHeight: scroll?.clientHeight || 0,
    olderDisabled: root?.querySelector('[data-action="older"]')?.disabled ?? null,
    newerDisabled: root?.querySelector('[data-action="newer"]')?.disabled ?? null,
    rootBottom: rootRect?.bottom ?? null,
    goalTop: goalRect?.top ?? null,
    formTop: formRect?.top ?? null,
    overlapsGoal: Boolean(rootRect && goalRect && rootRect.bottom > goalRect.top),
    overlapsComposer: Boolean(rootRect && formRect && rootRect.bottom > formRect.top),
  };
})()`;

try {
  await client.open();
  const before = await evaluate(stateExpression);
  assert.equal(before?.uiVersion, "3");
  assert.equal(before?.size, "compact");
  assert.equal(before?.controls, 4);

  await evaluate(`(() => {
    document.querySelector('#devspace-progress-narration-root [data-action="expand"]')?.click();
    return true;
  })()`);
  await wait(450);
  const expanded = await evaluate(stateExpression);
  assert.equal(expanded?.size, "expanded");
  assert.ok(expanded?.rendered >= 2, "Expanded card did not render the available progress history.");
  assert.ok(expanded?.scrollHeight > expanded?.clientHeight, "Expanded card did not expose a scrollable history viewport.");

  await evaluate(`(() => {
    document.querySelector('#devspace-progress-narration-root [data-action="older"]')?.click();
    return true;
  })()`);
  await wait(650);
  const older = await evaluate(stateExpression);
  assert.ok(older?.scrollTop < expanded?.scrollTop, "Older-progress control did not move the history upward.");

  await evaluate(`(() => {
    document.querySelector('#devspace-progress-narration-root [data-action="newer"]')?.click();
    return true;
  })()`);
  await wait(650);
  const latest = await evaluate(stateExpression);
  assert.ok(latest?.scrollTop >= latest?.scrollHeight - latest?.clientHeight - 2, "Latest-progress control did not return to the bottom.");

  await evaluate(`(() => {
    document.querySelector('#devspace-progress-narration-root [data-action="compact"]')?.click();
    return true;
  })()`);
  await wait(450);
  const compact = await evaluate(stateExpression);
  assert.equal(compact?.size, "compact");
  assert.equal(compact?.controls, 4);
  assert.equal(compact?.overlapsGoal, false);
  assert.equal(compact?.overlapsComposer, false);

  console.log(JSON.stringify({
    ok: true,
    gate: "progress-narration-live-controls",
    port,
    pagePath: new URL(page.url).pathname,
    before,
    expanded,
    older,
    latest,
    compact,
    syntheticUserMessages: 0,
    chatNavigation: 0,
    pageReloads: 0,
  }));
} finally {
  client.close();
}
