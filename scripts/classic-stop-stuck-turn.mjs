#!/usr/bin/env node
import assert from "node:assert/strict";
import { ClassicCdpClient } from "../dist/classic-cdp-client.js";

const port = Number(process.argv[2]);
const expectedConversationId = String(process.argv[3] || "").trim();
const apply = process.argv.includes("--apply");
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "CDP port is required.");
assert.match(expectedConversationId, /^[0-9a-z-]{16,200}$/i, "Expected conversation id is required.");
assert.equal(apply, true, "Refusing to mutate the page without --apply.");

const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) }).then((response) => response.json());
const pages = targets.filter((target) => target?.type === "page" && target.webSocketDebuggerUrl
  && new RegExp(`/c/${expectedConversationId}(?:[/?#]|$)`, "i").test(target.url || ""));
assert.equal(pages.length, 1, "Exact conversation page is missing or ambiguous.");
const page = pages[0];
const client = new ClassicCdpClient(page.webSocketDebuggerUrl, { callTimeoutMs: 8_000, maxPendingCalls: 4 });
await client.open();
try {
  const response = await client.call("Runtime.evaluate", {
    expression: `(() => {
      const expected = ${JSON.stringify(expectedConversationId)};
      const current = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || '';
      if (current !== expected) return { ok:false, reason:'conversation-changed', current };
      const composer = document.querySelector('#prompt-textarea');
      const composerText = String(composer?.innerText || composer?.textContent || '').trim();
      if (composerText) return { ok:false, reason:'composer-not-empty', composerLength:composerText.length };
      const buttons = [...document.querySelectorAll('button')].filter((button) => button.offsetParent !== null);
      const stop = buttons.find((button) => /停止|stop generating|stop response/i.test(
        (button.innerText || button.textContent || button.getAttribute('aria-label') || '').trim()
      ));
      if (!stop) return { ok:true, stopped:false, reason:'not-generating' };
      stop.click();
      return { ok:true, stopped:true, reason:'exact-stuck-turn-stopped' };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response?.exceptionDetails) throw new Error(response.exceptionDetails.text || "Runtime.evaluate failed.");
  const result = response?.result?.value;
  assert.equal(result?.ok, true, result?.reason || "Exact stop guard failed.");
  console.log(JSON.stringify({ ok: true, gate: "classic-stop-stuck-turn", port, conversationId: expectedConversationId, ...result }));
} finally {
  client.close();
}
