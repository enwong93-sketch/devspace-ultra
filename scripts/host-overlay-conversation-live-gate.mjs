#!/usr/bin/env node
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicCdpClient } from "../dist/classic-cdp-client.js";
import { loadConfig } from "../dist/config.js";
import { GoalRuntime } from "../dist/goal-runtime.js";
import { PlanRuntime } from "../dist/plan-runtime.js";
import { validateHostOverlayConversationAcceptance } from "../dist/host-overlay-acceptance.js";

const DEFAULT_PORTS = [9721, ...Array.from({ length: 31 }, (_, index) => 9732 + index)];

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? String(process.argv[index + 1]) : fallback;
}
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
function conversationIdFromUrl(value) {
  try { return new URL(String(value || "")).pathname.match(/\/c\/([^/?#]+)/)?.[1] || null; }
  catch { return null; }
}
async function pageTargets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return [];
    const targets = await response.json();
    return Array.isArray(targets)
      ? targets.filter((target) => target?.type === "page" && /chatgpt\.com/i.test(target.url || "") && target.webSocketDebuggerUrl)
      : [];
  } catch {
    return [];
  }
}

const INSPECTION_EXPRESSION = `(() => {
  const conversationId = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
  const roots = [document];
  const matched = [];
  const seen = new Set();
  while (roots.length && matched.length < 200) {
    const root = roots.shift();
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
      const attributes = [...element.attributes || []];
      const tagged = attributes.some((attribute) =>
        String(attribute.name || '').toLowerCase().includes('devspace')
        || String(attribute.value || '').toLowerCase().includes('devspace'));
      if (!tagged || seen.has(element)) continue;
      seen.add(element);
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
        && rect.width > 0 && rect.height > 0;
      if (!visible) continue;
      matched.push({
        tag: element.tagName,
        id: element.id || null,
        className: typeof element.className === 'string' ? element.className.slice(0, 300) : null,
        text: String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 2000)
      });
      if (matched.length >= 200) break;
    }
  }
  return {
    conversationId,
    overlayElementCount: matched.length,
    overlayText: matched.map((entry) => entry.text).filter(Boolean).join('\\n').slice(0, 20000),
    generating: Boolean(document.querySelector('button[data-testid="stop-button"]'))
  };
})()`;

async function inspectTarget(port, target) {
  const client = new ClassicCdpClient(target.webSocketDebuggerUrl, { callTimeoutMs: 8_000, maxPendingCalls: 8 });
  try {
    await client.open();
    const response = await client.call("Runtime.evaluate", {
      expression: INSPECTION_EXPRESSION,
      returnByValue: true,
      awaitPromise: false,
    });
    if (response?.exceptionDetails) throw new Error(response.exceptionDetails.text || "Runtime.evaluate failed");
    return {
      port,
      targetId: target.id || null,
      urlConversationId: conversationIdFromUrl(target.url),
      ...(response?.result?.value || {}),
    };
  } finally {
    client.close();
  }
}

async function discoverPages() {
  const pages = [];
  for (const port of DEFAULT_PORTS) {
    for (const target of await pageTargets(port)) {
      const conversationId = conversationIdFromUrl(target.url);
      if (!conversationId) continue;
      pages.push({ port, target, conversationId });
    }
  }
  return pages;
}

async function activePlans(runtime) {
  if (typeof runtime.activePlans === "function") return await runtime.activePlans({ limit: 100 });
  if (typeof runtime.list === "function") return await runtime.list({ status: "active", limit: 100 });
  throw new Error("PlanRuntime does not expose an active-plan reader.");
}

const configDir = resolve(argument("config-dir", join(homedir(), ".devspace-tailscale-bootstrap")));
const goalId = argument("goal-id", "goal_1b2f3eb499d8f460").trim();
const planId = argument("plan-id").trim();
const waitSeconds = Math.max(5, Math.min(60, Number(argument("wait-seconds", "25"))));
const config = loadConfig({ ...process.env, DEVSPACE_CONFIG_DIR: configDir });
if (config.classicHostOverlayEnabled !== true) throw new Error("Classic Host Overlay is not enabled in production config.");
if (config.contextGuardianEnabled === true || config.classicStreamRecoveryEnabled === true || config.autoCompactEnabled === true) {
  throw new Error("This phase requires Host Overlay-only production activation.");
}

const goalRuntime = new GoalRuntime({ stateDir: config.stateDir });
const planRuntime = new PlanRuntime({ stateDir: config.stateDir });
try {
  const goals = await goalRuntime.activeGoals({ limit: 100 });
  const goal = goals.find((candidate) => candidate.id === goalId);
  if (!goal) throw new Error(`Active Goal ${goalId} was not found.`);
  const plans = await activePlans(planRuntime);
  const matchingPlans = plans.filter((candidate) => candidate.conversationId === goal.conversationId);
  const plan = planId
    ? matchingPlans.find((candidate) => candidate.id === planId)
    : matchingPlans[0];
  if (!plan) throw new Error(`No active Plan is bound to Goal ${goalId}.`);

  const pages = await discoverPages();
  const aPage = pages.find((page) => page.conversationId === goal.conversationId);
  const bPage = pages.find((page) => page.conversationId !== goal.conversationId);
  if (!aPage) throw new Error("The authoritative Goal conversation is not open on any Main ChatGPT runtime.");
  if (!bPage) throw new Error("No second live ChatGPT conversation is available for cross-conversation leak acceptance.");

  const deadline = Date.now() + (waitSeconds * 1_000);
  let aFirst;
  do {
    aFirst = await inspectTarget(aPage.port, aPage.target);
    if (Number(aFirst.overlayElementCount || 0) > 0) break;
    await sleep(500);
  } while (Date.now() < deadline);
  const b = await inspectTarget(bPage.port, bPage.target);
  await sleep(500);
  const aSecond = await inspectTarget(aPage.port, aPage.target);

  const evidence = validateHostOverlayConversationAcceptance({
    goal,
    plan,
    activePlanCount: matchingPlans.length,
    aFirst,
    b,
    aSecond,
    automaticPageActions: 0,
  });
  console.log(JSON.stringify({
    ...evidence,
    gate: "host-overlay-conversation-live",
    aPort: aPage.port,
    bPort: bPage.port,
    backendConversationAuthority: "GoalRuntime native-bound conversationId",
    frontendEvidenceOnly: true,
    pageDomainsEnabled: false,
    urlOrDomUsedForBinding: false,
  }, null, 2));
} finally {
  await goalRuntime.close();
  await planRuntime.close();
}

if (process.argv[1] && resolve(process.argv[1]) !== resolve(fileURLToPath(import.meta.url))) {
  throw new Error(`${basename(fileURLToPath(import.meta.url))} must be executed as a script.`);
}
