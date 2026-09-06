#!/usr/bin/env node
const ENDPOINT = "http://127.0.0.1:7678/__devspace/progress";

function take(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const message = take("--message");
const doing = take("--doing");
const completed = take("--completed");
const clearCurrent = process.argv.includes("--clear-current");
const readOnly = process.argv.includes("--status");

try {
  const response = await fetch(ENDPOINT, readOnly ? {
    method: "GET",
    signal: AbortSignal.timeout(1500),
    cache: "no-store",
  } : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, doing, completed, clearCurrent }),
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`progress endpoint returned ${response.status}`);
  const body = await response.json();
  console.log(JSON.stringify({
    ok: true,
    latestMessage: Array.isArray(body?.messages) && body.messages.length ? body.messages.at(-1)?.text ?? null : null,
    messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
    current: body?.current?.text ?? null,
    completedCount: Array.isArray(body?.completed) ? body.completed.length : 0,
  }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
