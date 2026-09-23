import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-file.js";
import { defaultMainDebugPorts } from "./goal-host-bridge.js";
import { runtimeKeyForPort } from "./classic-stream-recovery-cdp.js";

const DEFAULT_CONNECTION_POLL_MS = 15_000;
const DEFAULT_SYNC_POLL_MS = 1_250;
const DEFAULT_PROBE_TIMEOUT_MS = 700;
const OVERLAY_SCHEMA_VERSION = 1;
const OVERLAY_ROOT_ID = "devspace-host-overlay-root";
const OVERLAY_STYLE_ID = "devspace-host-overlay-style";
const OVERLAY_CONTROLLER_KEY = "__devspaceClassicHostOverlayControllerV1";
const OVERLAY_LEASE_KEY = "__devspaceClassicHostOverlayLeaseV1";
const OVERLAY_LEASE_MS = 15_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanProjectionText(value, maxChars) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function safeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function projectionStep(step) {
  return {
    id: cleanProjectionText(step?.id, 120),
    text: cleanProjectionText(step?.text, 500),
    status: ["pending", "in_progress", "completed"].includes(step?.status) ? step.status : "pending",
  };
}

function normalizeOverlayOwner(value) {
  const goalId = cleanProjectionText(value?.goalId, 120);
  const runtimeKey = cleanProjectionText(value?.runtimeKey, 80);
  const conversationId = cleanProjectionText(value?.conversationId, 180);
  return goalId && runtimeKey && conversationId ? { goalId, runtimeKey, conversationId } : null;
}

export function createClassicHostOverlayOwnerStore({ stateDir } = {}) {
  const root = String(stateDir ?? "").trim();
  if (!root) throw new Error("Classic Host Overlay owner store requires stateDir.");
  const path = join(root, "classic-host-overlay-owner.json");
  return {
    path,
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        return normalizeOverlayOwner(parsed?.owner ?? parsed);
      } catch {
        return null;
      }
    },
    async save(owner) {
      const normalized = normalizeOverlayOwner(owner);
      await atomicWriteJson(path, { schemaVersion: OVERLAY_SCHEMA_VERSION, owner: normalized });
      return normalized;
    },
  };
}

export async function resolveClassicHostOverlayOwner({ goal, goalHostBridge, contextAdapter } = {}) {
  const goalId = cleanProjectionText(goal?.id, 120);
  const boundConversationId = cleanProjectionText(goal?.conversationId, 180) || null;
  if (!goalId || !contextAdapter || typeof contextAdapter.refreshSnapshot !== "function") return null;

  if (typeof goalHostBridge?.findMatchingCandidate === "function") {
    try {
      const candidate = await goalHostBridge.findMatchingCandidate(goalId, {
        conversationId: boundConversationId,
      });
      if (Number.isInteger(candidate?.runtimePort)) {
        const runtimeKey = runtimeKeyForPort(candidate.runtimePort);
        const snapshot = await contextAdapter.refreshSnapshot(runtimeKey);
        const conversationId = cleanProjectionText(snapshot?.conversationId, 180);
        if (
          snapshot?.ok
          && snapshot.mode !== "work"
          && conversationId
          && (!boundConversationId || conversationId === boundConversationId)
        ) {
          return { goalId, runtimeKey, conversationId };
        }
      }
    } catch {}
  }

  // Upgrade/reload bootstrap only: a hidden Context Guardian continuation can
  // exist before the fresh transcript has committed a Goal Dock iframe. Claim
  // it only when it is the sole hidden-style active Chat across every observed
  // Main. Any ambiguity fails closed and ordinary visible conversations never
  // qualify for this fallback.
  const runtimes = contextAdapter.status?.()?.runtimes || [];
  const hiddenActive = [];
  for (const runtime of runtimes) {
    const runtimeKey = cleanProjectionText(runtime?.runtimeKey, 80);
    if (!runtimeKey) continue;
    let snapshot = null;
    try { snapshot = await contextAdapter.refreshSnapshot(runtimeKey); } catch { continue; }
    const conversationId = cleanProjectionText(snapshot?.conversationId, 180);
    if (
      snapshot?.ok
      && snapshot.mode === "chat"
      && conversationId
      && (!boundConversationId || conversationId === boundConversationId)
      && snapshot.generating === true
      && Number(snapshot.composerTextChars || 0) === 0
      && Number(snapshot.visibleMessageCount || 0) === 0
    ) {
      hiddenActive.push({ goalId, runtimeKey, conversationId });
    }
  }
  return hiddenActive.length === 1 ? hiddenActive[0] : null;
}

export function normalizeClassicHostOverlayProjection({ goal = null, plan = null } = {}) {
  const normalizedGoal = goal
    ? {
        id: cleanProjectionText(goal.id, 120),
        objective: cleanProjectionText(goal.objective, 1_200),
        status: cleanProjectionText(goal.status, 40) || "active",
        round: Math.max(1, safeInteger(goal.round, 1)),
        roundState: cleanProjectionText(goal.roundState, 40) || "working",
        revision: Math.max(1, safeInteger(goal.revision, 1)),
        updatedAt: cleanProjectionText(goal.updatedAt, 80) || null,
      }
    : null;

  let normalizedPlan = null;
  if (plan) {
    const steps = Array.isArray(plan.steps) ? plan.steps.map(projectionStep) : [];
    const currentStepIndex = steps.findIndex((step) => step.status === "in_progress");
    const completedSteps = steps.filter((step) => step.status === "completed").length;
    normalizedPlan = {
      id: cleanProjectionText(plan.id, 120),
      title: cleanProjectionText(plan.title, 240),
      status: cleanProjectionText(plan.status, 40) || "active",
      revision: Math.max(1, safeInteger(plan.revision, 1)),
      updatedAt: cleanProjectionText(plan.updatedAt, 80) || null,
      currentStepIndex,
      currentStepNumber: currentStepIndex >= 0 ? currentStepIndex + 1 : Math.min(completedSteps, steps.length),
      completedSteps,
      totalSteps: steps.length,
      steps,
    };
  }

  return {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    projectedAt: new Date().toISOString(),
    goal: normalizedGoal,
    plan: normalizedPlan,
  };
}

function serializeInline(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function classicHostOverlayProjectionKey(projection, { expectedConversationId = null } = {}) {
  const state = normalizeClassicHostOverlayProjection(projection);
  const expectedConversation = cleanProjectionText(expectedConversationId, 160) || null;
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    expectedConversationId: expectedConversation,
    goal: state.goal ? {
      id: state.goal.id,
      status: state.goal.status,
      round: state.goal.round,
      roundState: state.goal.roundState,
      revision: state.goal.revision,
    } : null,
    plan: state.plan ? {
      id: state.plan.id,
      status: state.plan.status,
      revision: state.plan.revision,
    } : null,
  });
}

function normalizeConversationProjectionMap(value) {
  const map = {};
  if (!value || typeof value !== "object") return map;
  for (const [conversationId, projection] of Object.entries(value)) {
    const id = cleanProjectionText(conversationId, 180);
    if (!id) continue;
    map[id] = normalizeClassicHostOverlayProjection(projection);
  }
  return map;
}

export function buildClassicHostOverlayScript(projection, { expectedConversationId = null, conversationProjections = null } = {}) {
  const normalized = normalizeClassicHostOverlayProjection(projection);
  const serialized = serializeInline(normalized);
  const expectedConversation = cleanProjectionText(expectedConversationId, 160) || null;
  const projectionKey = classicHostOverlayProjectionKey(normalized, { expectedConversationId: expectedConversation });
  const conversationMapMode = Boolean(conversationProjections && typeof conversationProjections === "object");
  const conversationMap = normalizeConversationProjectionMap(conversationProjections);
  const serializedConversationMap = serializeInline(conversationMap);
  const conversationKeyMap = Object.fromEntries(Object.entries(conversationMap).map(([conversationId, value]) => [
    conversationId,
    classicHostOverlayProjectionKey(value, { expectedConversationId: conversationId }),
  ]));
  const serializedConversationKeys = serializeInline(conversationKeyMap);
  const emptyProjection = serializeInline(normalizeClassicHostOverlayProjection());
  return `(() => {
    const currentConversationId = location.pathname.match(/\\/c\\/([^/?#]+)/)?.[1] || null;
    const conversationProjectionMap = ${conversationMapMode ? serializedConversationMap : "null"};
    const conversationProjectionKeys = ${conversationMapMode ? serializedConversationKeys : "null"};
    const state = conversationProjectionMap ? (conversationProjectionMap[currentConversationId] || ${emptyProjection}) : ${serialized};
    const expectedConversationId = conversationProjectionMap ? currentConversationId : ${JSON.stringify(expectedConversation)};
    const projectionKey = conversationProjectionMap ? (conversationProjectionKeys[currentConversationId] || ('empty:' + String(currentConversationId || ''))) : ${JSON.stringify(projectionKey)};
    const ROOT_ID = ${JSON.stringify(OVERLAY_ROOT_ID)};
    const STYLE_ID = ${JSON.stringify(OVERLAY_STYLE_ID)};
    const CONTROLLER_KEY = ${JSON.stringify(OVERLAY_CONTROLLER_KEY)};
    const LEASE_KEY = ${JSON.stringify(OVERLAY_LEASE_KEY)};
    const LEASE_MS = ${JSON.stringify(OVERLAY_LEASE_MS)};
    const radios = [...document.querySelectorAll('[role="radio"]')];
    const work = radios.find((el) => /^(工作|Work)$/i.test((el.innerText || el.textContent || '').trim()));
    const isWork = work?.getAttribute('aria-checked') === 'true' || /[?&]surface=work(?:&|$)/i.test(location.search);

    const ensureStyle = () => {
      let style = document.getElementById(STYLE_ID);
      if (style) return style;
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = \`
#${OVERLAY_ROOT_ID}{position:fixed;inset:0;z-index:42;pointer-events:none;font-family:"Söhne",Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0d0d0d;--ds-surface:rgba(255,255,255,.96);--ds-border:#e5e5e5;--ds-muted:#6e6e6e;--ds-soft:#f5f5f5;--ds-shadow:0 8px 24px rgba(13,13,13,.08);opacity:1;visibility:visible;transition:opacity 200ms cubic-bezier(.23,1,.32,1)}
#${OVERLAY_ROOT_ID}[data-hidden="true"]{opacity:0;visibility:hidden;transition:opacity 140ms cubic-bezier(.23,1,.32,1),visibility 0s linear 140ms}
#${OVERLAY_ROOT_ID} .devspace-goal-strip{position:fixed;box-sizing:border-box;display:flex;align-items:center;gap:10px;min-height:36px;padding:7px 11px;border:1px solid var(--ds-border);border-radius:12px;background:var(--ds-surface);box-shadow:0 4px 16px rgba(13,13,13,.06);overflow:hidden;pointer-events:none;opacity:1;visibility:visible;transform:translateY(0);transition:opacity 200ms cubic-bezier(.23,1,.32,1),transform 200ms cubic-bezier(.23,1,.32,1)}
#${OVERLAY_ROOT_ID} .devspace-goal-strip[data-visible="false"]{opacity:0;visibility:hidden;transform:translateY(4px);transition:opacity 140ms cubic-bezier(.23,1,.32,1),transform 140ms cubic-bezier(.23,1,.32,1),visibility 0s linear 140ms}
#${OVERLAY_ROOT_ID} .devspace-goal-label,#${OVERLAY_ROOT_ID} .devspace-plan-label{flex:0 0 auto;font-size:11px;line-height:1.4;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ds-muted)}
#${OVERLAY_ROOT_ID} .devspace-goal-objective{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:1.45;font-weight:500;color:inherit}
#${OVERLAY_ROOT_ID} .devspace-goal-meta{flex:0 0 auto;white-space:nowrap;font-size:11px;line-height:1.4;font-weight:500;color:var(--ds-muted)}
#${OVERLAY_ROOT_ID} .devspace-plan-hud{position:fixed;box-sizing:border-box;width:min(286px,calc(100vw - 24px));padding:11px 12px;border:1px solid var(--ds-border);border-radius:14px;background:var(--ds-surface);box-shadow:var(--ds-shadow);pointer-events:auto;opacity:1;visibility:visible;transform:translateY(0);transition:opacity 200ms cubic-bezier(.23,1,.32,1),transform 200ms cubic-bezier(.23,1,.32,1)}
#${OVERLAY_ROOT_ID} .devspace-plan-hud[data-visible="false"]{opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-4px);transition:opacity 140ms cubic-bezier(.23,1,.32,1),transform 140ms cubic-bezier(.23,1,.32,1),visibility 0s linear 140ms}
#${OVERLAY_ROOT_ID} .devspace-plan-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
#${OVERLAY_ROOT_ID} .devspace-plan-progress{font-size:11px;line-height:1.4;font-weight:500;color:var(--ds-muted);font-variant-numeric:tabular-nums}
#${OVERLAY_ROOT_ID} .devspace-plan-title{margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:1.45;font-weight:600;color:inherit}
#${OVERLAY_ROOT_ID} .devspace-plan-current{margin-top:2px;display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;font-size:12px;line-height:1.45;font-weight:400;color:var(--ds-muted)}
#${OVERLAY_ROOT_ID} .devspace-plan-details{margin-top:7px;border-top:1px solid var(--ds-border);padding-top:6px}
#${OVERLAY_ROOT_ID} .devspace-plan-details summary{cursor:pointer;list-style:none;user-select:none;font-size:11px;line-height:1.45;font-weight:500;color:var(--ds-muted);outline:none}
#${OVERLAY_ROOT_ID} .devspace-plan-details summary::-webkit-details-marker{display:none}
#${OVERLAY_ROOT_ID} .devspace-plan-details summary:focus-visible{outline:2px solid #10a37f;outline-offset:2px;border-radius:4px}
#${OVERLAY_ROOT_ID} .devspace-plan-list{margin:6px 0 0;padding:0;max-height:210px;overflow:auto;list-style:none}
#${OVERLAY_ROOT_ID} .devspace-plan-step{display:grid;grid-template-columns:38px minmax(0,1fr);gap:6px;padding:4px 0;font-size:11px;line-height:1.45;color:var(--ds-muted)}
#${OVERLAY_ROOT_ID} .devspace-plan-step[data-status="in_progress"]{color:inherit;font-weight:500}
#${OVERLAY_ROOT_ID} .devspace-plan-step[data-status="completed"]{opacity:.7}
#${OVERLAY_ROOT_ID} .devspace-plan-step-state{font-size:10px;letter-spacing:.02em;color:var(--ds-muted)}
#${OVERLAY_ROOT_ID} .devspace-plan-step-text{min-width:0;overflow-wrap:anywhere}
html.dark #${OVERLAY_ROOT_ID}{color:#f0f0f0;--ds-surface:rgba(33,33,33,.96);--ds-border:rgba(255,255,255,.10);--ds-muted:#b4b4b4;--ds-soft:#2a2a2a;--ds-shadow:0 8px 24px rgba(0,0,0,.22)}
@media (prefers-color-scheme:dark){html:not(.light) #${OVERLAY_ROOT_ID}{color:#f0f0f0;--ds-surface:rgba(33,33,33,.96);--ds-border:rgba(255,255,255,.10);--ds-muted:#b4b4b4;--ds-soft:#2a2a2a;--ds-shadow:0 8px 24px rgba(0,0,0,.22)}}
@media (max-width:760px){#${OVERLAY_ROOT_ID} .devspace-goal-label{display:none}#${OVERLAY_ROOT_ID} .devspace-goal-strip{min-height:34px;padding:6px 9px}#${OVERLAY_ROOT_ID} .devspace-plan-hud{width:156px;padding:8px 9px}#${OVERLAY_ROOT_ID} .devspace-plan-title,#${OVERLAY_ROOT_ID} .devspace-plan-current,#${OVERLAY_ROOT_ID} .devspace-plan-details{display:none}}
@media (prefers-reduced-motion:reduce){#${OVERLAY_ROOT_ID} *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
      \`;
      document.head.appendChild(style);
      return style;
    };

    const ensureRoot = () => {
      let root = document.getElementById(ROOT_ID);
      if (!root) {
        root = document.createElement('div');
        root.id = ROOT_ID;
        root.setAttribute('role', 'region');
        root.setAttribute('aria-label', 'DevSpace Goal and Plan status');
        document.body.appendChild(root);
      }
      return root;
    };

    const ensureChild = (root, className, tagName = 'div') => {
      let node = root.querySelector('.' + className);
      if (!node) {
        node = document.createElement(tagName);
        node.className = className;
        root.appendChild(node);
      }
      return node;
    };

    const addText = (parent, className, text, tagName = 'div') => {
      const node = document.createElement(tagName);
      node.className = className;
      node.textContent = String(text ?? '');
      parent.appendChild(node);
      return node;
    };

    const statusLabel = (status) => {
      const value = String(status || '').toLowerCase();
      if (value === 'paused') return 'Paused';
      if (value === 'blocked') return 'Blocked';
      if (value === 'completed') return 'Completed';
      if (value === 'stopped') return 'Stopped';
      return 'Active';
    };

    const wrongConversation = Boolean(expectedConversationId && currentConversationId !== expectedConversationId);
    const shouldHide = isWork || wrongConversation || (!state.goal && !state.plan);
    const renderKey = projectionKey + '|mode=' + (isWork ? 'work' : 'chat') + '|conversation=' + String(currentConversationId || '');
    ensureStyle();
    const root = ensureRoot();
    const armProjectionLease = () => {
      const previous = globalThis[LEASE_KEY];
      if (previous?.timer) {
        try { clearTimeout(previous.timer); } catch {}
      }
      if (shouldHide) {
        delete globalThis[LEASE_KEY];
        return;
      }
      const nonce = String(Date.now()) + ':' + Math.random().toString(36).slice(2);
      root.dataset.leaseNonce = nonce;
      const timer = setTimeout(() => {
        const currentRoot = document.getElementById(ROOT_ID);
        if (!currentRoot || currentRoot.dataset.leaseNonce !== nonce) return;
        currentRoot.dataset.hidden = 'true';
        const staleGoal = currentRoot.querySelector('.devspace-goal-strip');
        const stalePlan = currentRoot.querySelector('.devspace-plan-hud');
        if (staleGoal) staleGoal.dataset.visible = 'false';
        if (stalePlan) stalePlan.dataset.visible = 'false';
      }, LEASE_MS);
      globalThis[LEASE_KEY] = { nonce, timer };
    };
    armProjectionLease();

    if (root.dataset.renderKey === renderKey) {
      const unchangedGoal = root.querySelector('.devspace-goal-strip');
      const unchangedPlan = root.querySelector('.devspace-plan-hud');
      const existingController = globalThis[CONTROLLER_KEY];
      const canSkipContent = (!state.goal || unchangedGoal) && (!state.plan || unchangedPlan) && typeof existingController?.position === 'function';
      if (canSkipContent) {
        root.dataset.schemaVersion = String(state.schemaVersion || 1);
        root.dataset.goalRevision = String(state.goal?.revision ?? '');
        root.dataset.planRevision = String(state.plan?.revision ?? '');
        root.dataset.hidden = shouldHide ? 'true' : 'false';
        if (unchangedGoal) unchangedGoal.dataset.visible = state.goal ? 'true' : 'false';
        if (unchangedPlan) unchangedPlan.dataset.visible = state.plan ? 'true' : 'false';
        existingController.bind?.();
        existingController.schedule?.();
        existingController.position?.();
        const unchangedComposer = document.querySelector('#prompt-textarea')?.closest('form') || document.querySelector('#thread-bottom-container form');
        const unchangedGoalRect = unchangedGoal?.dataset.visible === 'false' ? null : unchangedGoal?.getBoundingClientRect();
        const unchangedPlanRect = unchangedPlan?.dataset.visible === 'false' ? null : unchangedPlan?.getBoundingClientRect();
        const unchangedComposerRect = unchangedComposer?.getBoundingClientRect();
        return {
          mounted:Boolean(root.dataset.hidden !== 'true'),
          skipped:true,
          contentWrites:0,
          mode:isWork ? 'work' : 'chat',
          conversationId:currentConversationId,
          rootCount:document.querySelectorAll('#' + ROOT_ID).length,
          goalCount:document.querySelectorAll('#' + ROOT_ID + ' .devspace-goal-strip').length,
          planCount:document.querySelectorAll('#' + ROOT_ID + ' .devspace-plan-hud').length,
          goalVisible:Boolean(state.goal && unchangedGoalRect?.width > 0 && unchangedGoalRect?.height > 0),
          planVisible:Boolean(state.plan && unchangedPlanRect?.width > 0 && unchangedPlanRect?.height > 0),
          goalGap:unchangedGoalRect && unchangedComposerRect ? Math.round(unchangedComposerRect.top - unchangedGoalRect.bottom) : null,
          goalRevision:state.goal?.revision ?? null,
          planRevision:state.plan?.revision ?? null,
          planTop:unchangedPlanRect ? Math.round(unchangedPlanRect.top) : null,
          planRight:unchangedPlanRect ? Math.round(innerWidth - unchangedPlanRect.right) : null,
        };
      }
    }

    root.dataset.renderKey = renderKey;
    root.dataset.schemaVersion = String(state.schemaVersion || 1);
    root.dataset.goalRevision = String(state.goal?.revision ?? '');
    root.dataset.planRevision = String(state.plan?.revision ?? '');
    root.dataset.hidden = shouldHide ? 'true' : 'false';

    if (isWork || wrongConversation) {
      return {
        mounted:false,
        mode:isWork ? 'work' : 'chat',
        reason:isWork ? 'work-mode' : 'conversation-owner-mismatch',
        conversationId:currentConversationId,
        rootCount:document.querySelectorAll('#' + ROOT_ID).length,
      };
    }

    const goal = ensureChild(root, 'devspace-goal-strip');
    if (state.goal) {
      const goalRenderKey = state.goal.id + ':' + state.goal.revision + ':' + state.goal.status + ':' + state.goal.round;
      goal.dataset.visible = 'true';
      if (goal.dataset.renderKey !== goalRenderKey) {
        goal.replaceChildren();
        goal.setAttribute('aria-label', 'DevSpace Goal status');
        addText(goal, 'devspace-goal-label', 'Goal');
        addText(goal, 'devspace-goal-objective', state.goal.objective || 'Active Goal');
        addText(goal, 'devspace-goal-meta', 'Round ' + state.goal.round + ' / ' + statusLabel(state.goal.status));
        goal.dataset.renderKey = goalRenderKey;
      }
    } else {
      goal.dataset.visible = 'false';
    }

    const plan = ensureChild(root, 'devspace-plan-hud');
    if (state.plan) {
      const planRenderKey = state.plan.id + ':' + state.plan.revision + ':' + state.plan.status;
      plan.dataset.visible = 'true';
      if (plan.dataset.renderKey !== planRenderKey) {
        const detailsWasOpen = Boolean(plan.querySelector('.devspace-plan-details')?.open);
        plan.replaceChildren();
        plan.setAttribute('aria-label', 'DevSpace Plan status');
        const head = document.createElement('div');
        head.className = 'devspace-plan-head';
        addText(head, 'devspace-plan-label', 'Plan');
        addText(head, 'devspace-plan-progress', 'Step ' + String(state.plan.currentStepNumber || state.plan.completedSteps || 0) + ' / ' + String(state.plan.totalSteps || 0));
        plan.appendChild(head);
        addText(plan, 'devspace-plan-title', state.plan.title || 'Execution plan');
        const current = state.plan.currentStepIndex >= 0 ? state.plan.steps[state.plan.currentStepIndex] : null;
        addText(plan, 'devspace-plan-current', current?.text || 'Plan active');
        const details = document.createElement('details');
        details.className = 'devspace-plan-details';
        details.open = detailsWasOpen;
        addText(details, '', 'Steps', 'summary');
        const list = document.createElement('ol');
        list.className = 'devspace-plan-list';
        state.plan.steps.forEach((step) => {
          const item = document.createElement('li');
          item.className = 'devspace-plan-step';
          item.dataset.status = step.status;
          const stateText = step.status === 'completed' ? 'Done' : step.status === 'in_progress' ? 'Now' : 'Next';
          addText(item, 'devspace-plan-step-state', stateText);
          addText(item, 'devspace-plan-step-text', step.text);
          list.appendChild(item);
        });
        details.appendChild(list);
        plan.appendChild(details);
        plan.dataset.renderKey = planRenderKey;
      }
    } else {
      plan.dataset.visible = 'false';
    }

    const setStyleIfChanged = (node, property, value) => {
      if (node?.style?.[property] !== value) node.style[property] = value;
    };

    const position = () => {
      const currentRoot = document.getElementById(ROOT_ID);
      if (!currentRoot || currentRoot.dataset.hidden === 'true') return;
      const composer = document.querySelector('#prompt-textarea');
      const composerForm = composer?.closest('form') || document.querySelector('#thread-bottom-container form');
      const currentGoal = currentRoot.querySelector('.devspace-goal-strip');
      if (state.goal && composerForm && currentGoal?.dataset.visible !== 'false') {
        const rect = composerForm.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          setStyleIfChanged(currentGoal, 'left', Math.max(8, Math.round(rect.left)) + 'px');
          setStyleIfChanged(currentGoal, 'width', Math.max(160, Math.round(rect.width)) + 'px');
          setStyleIfChanged(currentGoal, 'bottom', Math.max(8, Math.round(innerHeight - rect.top + 8)) + 'px');
        }
      }
      const currentPlan = currentRoot.querySelector('.devspace-plan-hud');
      if (state.plan && currentPlan?.dataset.visible !== 'false') {
        const main = document.querySelector('main#main') || composer?.closest('main');
        const mainRect = main?.getBoundingClientRect();
        setStyleIfChanged(currentPlan, 'top', Math.max(58, Math.round((mainRect?.top ?? 46) + 12)) + 'px');
        setStyleIfChanged(currentPlan, 'right', Math.max(12, Math.round(innerWidth - (mainRect?.right ?? innerWidth) + 12)) + 'px');
      }
    };

    let controller = globalThis[CONTROLLER_KEY];
    if (!controller) {
      let raf = 0;
      const observed = new Set();
      const schedule = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          try { globalThis[CONTROLLER_KEY]?.position?.(); } catch {}
        });
      };
      const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
      const bind = () => {
        const composer = document.querySelector('#prompt-textarea');
        const composerForm = composer?.closest('form') || document.querySelector('#thread-bottom-container form');
        const main = document.querySelector('main#main') || composer?.closest('main');
        const bottom = document.querySelector('#thread-bottom-container');
        [composerForm, main, bottom].filter(Boolean).forEach((node) => {
          if (!resizeObserver || observed.has(node)) return;
          observed.add(node);
          try { resizeObserver.observe(node); } catch {}
        });
      };
      addEventListener('resize', schedule, { passive:true });
      controller = { resizeObserver, observed, bind, schedule, position };
      globalThis[CONTROLLER_KEY] = controller;
    } else {
      controller.position = position;
    }
    controller.bind?.();
    controller.schedule();
    position();

    const goalRect = goal?.dataset.visible === 'false' ? null : goal?.getBoundingClientRect();
    const planRect = plan?.dataset.visible === 'false' ? null : plan?.getBoundingClientRect();
    const composerForm = document.querySelector('#prompt-textarea')?.closest('form') || document.querySelector('#thread-bottom-container form');
    const composerRect = composerForm?.getBoundingClientRect();
    return {
      mounted:root.dataset.hidden !== 'true',
      skipped:false,
      contentWrites:1,
      mode:'chat',
      rootCount:document.querySelectorAll('#' + ROOT_ID).length,
      goalCount:document.querySelectorAll('#' + ROOT_ID + ' .devspace-goal-strip').length,
      planCount:document.querySelectorAll('#' + ROOT_ID + ' .devspace-plan-hud').length,
      goalVisible:Boolean(state.goal && goalRect?.width > 0 && goalRect?.height > 0),
      planVisible:Boolean(state.plan && planRect?.width > 0 && planRect?.height > 0),
      goalGap:goalRect && composerRect ? Math.round(composerRect.top - goalRect.bottom) : null,
      goalRevision:state.goal?.revision ?? null,
      planRevision:state.plan?.revision ?? null,
      planTop:planRect ? Math.round(planRect.top) : null,
      planRight:planRect ? Math.round(innerWidth - planRect.right) : null,
    };
  })()`;
}

function inspectOverlayExpression() {
  return `(() => {
    const root = document.getElementById(${JSON.stringify(OVERLAY_ROOT_ID)});
    const radios = [...document.querySelectorAll('[role="radio"]')];
    const work = radios.find((el) => /^(工作|Work)$/i.test((el.innerText || el.textContent || '').trim()));
    const mode = work?.getAttribute('aria-checked') === 'true' || /[?&]surface=work(?:&|$)/i.test(location.search) ? 'work' : 'chat';
    const goal = root?.querySelector('.devspace-goal-strip');
    const plan = root?.querySelector('.devspace-plan-hud');
    const composerForm = document.querySelector('#prompt-textarea')?.closest('form') || document.querySelector('#thread-bottom-container form');
    const goalRect = goal?.getBoundingClientRect();
    const planRect = plan?.getBoundingClientRect();
    const composerRect = composerForm?.getBoundingClientRect();
    const visible = (el, rect) => Boolean(el && root?.dataset.hidden !== 'true' && el.dataset.visible !== 'false' && getComputedStyle(el).visibility !== 'hidden' && rect?.width > 0 && rect?.height > 0);
    const match = location.pathname.match(/\\/c\\/([^/?#]+)/);
    const composer = document.querySelector('#prompt-textarea');
    const composerText = (composer?.innerText || composer?.textContent || '').replace(/\\u2060/g, '').trim();
    return {
      mounted:Boolean(root && root.dataset.hidden !== 'true'),
      renderKey:root?.dataset.renderKey || null,
      mode,
      href:location.href,
      conversationId:match?.[1] || null,
      generating:Boolean(document.querySelector('button[data-testid="stop-button"]')),
      composerTextChars:composerText.length,
      viewportWidth:innerWidth,
      viewportHeight:innerHeight,
      rootCount:document.querySelectorAll('#' + ${JSON.stringify(OVERLAY_ROOT_ID)}).length,
      goalCount:document.querySelectorAll('#' + ${JSON.stringify(OVERLAY_ROOT_ID)} + ' .devspace-goal-strip').length,
      planCount:document.querySelectorAll('#' + ${JSON.stringify(OVERLAY_ROOT_ID)} + ' .devspace-plan-hud').length,
      goalVisible:visible(goal, goalRect),
      planVisible:visible(plan, planRect),
      goalGap:goalRect && composerRect ? Math.round(composerRect.top - goalRect.bottom) : null,
      planTop:planRect ? Math.round(planRect.top) : null,
      planRight:planRect ? Math.round(innerWidth - planRect.right) : null,
      goalRevision:root?.dataset.goalRevision ? Number(root.dataset.goalRevision) : null,
      planRevision:root?.dataset.planRevision ? Number(root.dataset.planRevision) : null,
      goalText:(goal?.innerText || goal?.textContent || '').trim(),
      planText:(plan?.innerText || plan?.textContent || '').trim(),
    };
  })()`;
}

async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable for Classic host overlay.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

class CdpClient {
  constructor(url, { WebSocketImpl = globalThis.WebSocket } = {}) {
    if (typeof WebSocketImpl !== "function") throw new Error("WebSocket is unavailable for Classic host overlay.");
    this.ws = new WebSocketImpl(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", (event) => reject(event?.error || new Error("Classic host overlay CDP websocket failed")), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function evaluate(client, expression) {
  const result = await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Classic host overlay CDP evaluate failed.");
  return result.result?.value;
}

export async function connectClassicHostOverlayPort(port, {
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  onDisconnected,
} = {}) {
  let targets;
  try {
    targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, { fetchImpl, timeoutMs: probeTimeoutMs });
  } catch {
    return null;
  }
  if (!Array.isArray(targets)) return null;
  const page = targets.find((target) => target?.type === "page" && /chatgpt\.com/i.test(target.url || "") && typeof target.webSocketDebuggerUrl === "string");
  if (!page) return null;

  const runtimeKey = runtimeKeyForPort(port);
  const client = new CdpClient(page.webSocketDebuggerUrl, { WebSocketImpl });
  await client.open();
  await client.call("Runtime.enable");
  await client.call("Page.enable");
  const closeListener = () => { try { onDisconnected?.({ runtimeKey, port }); } catch {} };
  client.ws.addEventListener?.("close", closeListener, { once: true });

  return {
    runtimeKey,
    port,
    async sync(value) {
      return await evaluate(client, buildClassicHostOverlayScript(value));
    },
    async syncConversationMap(value) {
      return await evaluate(client, buildClassicHostOverlayScript({}, { conversationProjections: value }));
    },
    async inspect() {
      return await evaluate(client, inspectOverlayExpression());
    },
    async close() {
      client.close();
      await sleep(0);
    },
  };
}

export class ClassicHostOverlayContextAdapter {
  constructor({ contextAdapter } = {}) {
    if (!contextAdapter || typeof contextAdapter.status !== "function" || typeof contextAdapter.evaluateRuntime !== "function") {
      throw new Error("ClassicHostOverlayContextAdapter requires the shared Context Guardian CDP adapter.");
    }
    this.contextAdapter = contextAdapter;
  }

  async start() {
    return this.status();
  }

  async syncAll(projection, { owner = null } = {}) {
    const runtimes = this.contextAdapter.status()?.runtimes || [];
    const settled = await Promise.allSettled(runtimes.map(async (runtime) => {
      const ownsProjection = Boolean(
        owner?.runtimeKey === runtime.runtimeKey
        && typeof owner?.conversationId === "string"
        && owner.conversationId.trim(),
      );
      const runtimeProjection = ownsProjection ? projection : {};
      return {
        runtimeKey: runtime.runtimeKey,
        port: runtime.port,
        result: await this.contextAdapter.evaluateRuntime(
          runtime.runtimeKey,
          buildClassicHostOverlayScript(runtimeProjection, {
            expectedConversationId: ownsProjection ? owner.conversationId : null,
          }),
        ),
      };
    }));
    const results = settled.map((entry, index) => entry.status === "fulfilled"
      ? { ok:true, ...entry.value }
      : {
          ok:false,
          runtimeKey:runtimes[index]?.runtimeKey ?? null,
          port:runtimes[index]?.port ?? null,
          error:entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        });
    return {
      connected: runtimes.length,
      synced: results.filter((entry) => entry.ok).length,
      results,
    };
  }

  async syncConversationMap(projectionsByConversation) {
    const runtimes = this.contextAdapter.status()?.runtimes || [];
    const settled = await Promise.allSettled(runtimes.map(async (runtime) => ({
      runtimeKey: runtime.runtimeKey,
      port: runtime.port,
      result: await this.contextAdapter.evaluateRuntime(
        runtime.runtimeKey,
        buildClassicHostOverlayScript({}, { conversationProjections: projectionsByConversation }),
      ),
    })));
    const results = settled.map((entry, index) => entry.status === "fulfilled"
      ? { ok:true, ...entry.value }
      : {
          ok:false,
          runtimeKey:runtimes[index]?.runtimeKey ?? null,
          port:runtimes[index]?.port ?? null,
          error:entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        });
    return {
      connected: runtimes.length,
      synced: results.filter((entry) => entry.ok).length,
      results,
    };
  }

  async inspect(runtimeKey) {
    return await this.contextAdapter.evaluateRuntime(runtimeKey, inspectOverlayExpression());
  }

  status() {
    const status = this.contextAdapter.status?.() || {};
    return {
      connected: Number(status.connected || 0),
      runtimes: Array.isArray(status.runtimes) ? status.runtimes.map((runtime) => ({ runtimeKey:runtime.runtimeKey, port:runtime.port })) : [],
    };
  }
}

export class ClassicHostOverlayCdpAdapter {
  constructor({
    ports = defaultMainDebugPorts(),
    connectPort,
    connectionPollMs = DEFAULT_CONNECTION_POLL_MS,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  } = {}) {
    this.ports = [...ports];
    this.connectionPollMs = connectionPollMs;
    this.options = { fetchImpl, WebSocketImpl, probeTimeoutMs };
    this.connectPort = connectPort || ((port, options) => connectClassicHostOverlayPort(port, { ...this.options, ...options }));
    this.sessions = new Map();
    this.timer = null;
    this.polling = null;
    this.closed = false;
  }

  async start({ schedule = true } = {}) {
    await this.pollConnections();
    if (schedule && !this.closed && this.connectionPollMs > 0 && !this.timer) {
      this.timer = setInterval(() => { void this.pollConnections(); }, this.connectionPollMs);
      this.timer.unref?.();
    }
    return this.status();
  }

  async pollConnections() {
    if (this.closed) return this.status();
    if (this.polling) return this.polling;
    this.polling = this.#pollConnectionsImpl().finally(() => { this.polling = null; });
    return this.polling;
  }

  async #pollConnectionsImpl() {
    for (const port of this.ports) {
      const runtimeKey = runtimeKeyForPort(port);
      if (this.sessions.has(runtimeKey)) continue;
      let session = null;
      try {
        session = await this.connectPort(port, {
          onDisconnected: ({ runtimeKey: disconnectedKey }) => {
            const current = this.sessions.get(disconnectedKey);
            if (current === session) this.sessions.delete(disconnectedKey);
          },
        });
      } catch {
        session = null;
      }
      if (session?.runtimeKey) this.sessions.set(session.runtimeKey, session);
    }
    return this.status();
  }

  async syncAll(projection) {
    const sessions = [...this.sessions.values()];
    const settled = await Promise.allSettled(sessions.map(async (session) => ({
      runtimeKey: session.runtimeKey,
      port: session.port,
      result: await session.sync(projection),
    })));
    const results = settled.map((entry, index) => entry.status === "fulfilled"
      ? { ok:true, ...entry.value }
      : {
          ok:false,
          runtimeKey:sessions[index]?.runtimeKey ?? null,
          port:sessions[index]?.port ?? null,
          error:entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        });
    return {
      connected: sessions.length,
      synced: results.filter((entry) => entry.ok).length,
      results,
    };
  }

  async syncConversationMap(projectionsByConversation) {
    const sessions = [...this.sessions.values()];
    const settled = await Promise.allSettled(sessions.map(async (session) => ({
      runtimeKey: session.runtimeKey,
      port: session.port,
      result: await session.syncConversationMap(projectionsByConversation),
    })));
    const results = settled.map((entry, index) => entry.status === "fulfilled"
      ? { ok:true, ...entry.value }
      : {
          ok:false,
          runtimeKey:sessions[index]?.runtimeKey ?? null,
          port:sessions[index]?.port ?? null,
          error:entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        });
    return {
      connected: sessions.length,
      synced: results.filter((entry) => entry.ok).length,
      results,
    };
  }

  async inspect(runtimeKey) {
    const session = this.sessions.get(runtimeKey);
    if (!session) throw new Error(`Classic host overlay runtime ${runtimeKey} is not connected.`);
    return await session.inspect();
  }

  status() {
    return {
      connected: this.sessions.size,
      runtimes: [...this.sessions.values()].map((session) => ({ runtimeKey:session.runtimeKey, port:session.port })),
    };
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.polling) await this.polling.catch(() => {});
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close?.()));
  }
}

function conversationIdOf(value) {
  return cleanProjectionText(value?.conversationId, 180) || null;
}

export function conversationBoundProjectionMap({ goals = [], plans = [] } = {}) {
  const result = {};
  for (const goal of Array.isArray(goals) ? goals : []) {
    const conversationId = conversationIdOf(goal);
    if (!conversationId) continue;
    result[conversationId] ??= { goal: null, plan: null };
    if (!result[conversationId].goal) result[conversationId].goal = goal;
  }
  for (const plan of Array.isArray(plans) ? plans : []) {
    const conversationId = conversationIdOf(plan);
    if (!conversationId) continue;
    result[conversationId] ??= { goal: null, plan: null };
    if (!result[conversationId].plan) result[conversationId].plan = plan;
  }
  return result;
}

function overlayProjectionSyncKey(projection, owner, adapterStatus = null) {
  const runtimes = Array.isArray(adapterStatus?.runtimes)
    ? adapterStatus.runtimes
        .map((runtime) => `${cleanProjectionText(runtime?.runtimeKey, 80)}:${safeInteger(runtime?.port, 0)}`)
        .sort()
    : [];
  return JSON.stringify({
    goal: projection.goal ? {
      id: projection.goal.id,
      status: projection.goal.status,
      round: projection.goal.round,
      roundState: projection.goal.roundState,
      revision: projection.goal.revision,
    } : null,
    plan: projection.plan ? {
      id: projection.plan.id,
      status: projection.plan.status,
      revision: projection.plan.revision,
    } : null,
    owner: normalizeOverlayOwner(owner),
    runtimes,
  });
}

export class ClassicHostOverlayProjection {
  constructor({
    goalRuntime,
    planRuntime,
    adapter,
    resolveOwner,
    ownerStore,
    pollMs = DEFAULT_SYNC_POLL_MS,
  } = {}) {
    if (!goalRuntime) throw new Error("ClassicHostOverlayProjection requires goalRuntime.");
    if (!planRuntime) throw new Error("ClassicHostOverlayProjection requires planRuntime.");
    if (!adapter || typeof adapter.syncAll !== "function") throw new Error("ClassicHostOverlayProjection requires an adapter with syncAll().");
    this.goalRuntime = goalRuntime;
    this.planRuntime = planRuntime;
    this.adapter = adapter;
    this.resolveOwner = typeof resolveOwner === "function" ? resolveOwner : null;
    this.ownerStore = ownerStore && typeof ownerStore.load === "function" && typeof ownerStore.save === "function" ? ownerStore : null;
    this.ownerHydrated = false;
    this.owner = null;
    this.pollMs = pollMs;
    this.timer = null;
    this.syncing = null;
    this.closed = false;
    this.last = null;
    this.ownerRebindRequest = null;
  }

  async start({ schedule = true } = {}) {
    const result = await this.syncOnce();
    if (schedule && !this.closed && this.pollMs > 0 && !this.timer) {
      this.timer = setInterval(() => { void this.syncOnce(); }, this.pollMs);
      this.timer.unref?.();
    }
    return result;
  }

  async syncOnce() {
    if (this.closed) return this.last;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const [goals, plans] = await Promise.all([
        typeof this.goalRuntime.projectableGoals === "function"
          ? this.goalRuntime.projectableGoals({ limit: 50 })
          : this.goalRuntime.activeGoals({ limit: 50 }),
        this.planRuntime.activePlans({ limit: 50 }),
      ]);
      if (!this.ownerHydrated) {
        this.ownerHydrated = true;
        if (this.ownerStore) {
          try { this.owner = normalizeOverlayOwner(await this.ownerStore.load()); } catch {}
        }
      }
      const conversationProjections = conversationBoundProjectionMap({ goals, plans });
      const boundConversationIds = Object.keys(conversationProjections).sort();
      if (boundConversationIds.length > 0 && typeof this.adapter.syncConversationMap === "function") {
        this.ownerRebindRequest = null;
        if (this.owner) {
          this.owner = null;
          try { await this.ownerStore?.save(null); } catch {}
        }
        const result = await this.adapter.syncConversationMap(conversationProjections);
        const adapterStatus = typeof this.adapter.status === "function" ? this.adapter.status() : null;
        const syncKey = JSON.stringify({
          conversations: boundConversationIds.map((conversationId) => {
            const projection = normalizeClassicHostOverlayProjection(conversationProjections[conversationId]);
            return {
              conversationId,
              goalId: projection.goal?.id ?? null,
              goalRevision: projection.goal?.revision ?? null,
              planId: projection.plan?.id ?? null,
              planRevision: projection.plan?.revision ?? null,
            };
          }),
          runtimes: Array.isArray(adapterStatus?.runtimes)
            ? adapterStatus.runtimes.map((runtime) => `${runtime?.runtimeKey || ""}:${runtime?.port || 0}`).sort()
            : [],
        });
        this.last = {
          mode: "conversation-bound",
          conversationProjections: normalizeConversationProjectionMap(conversationProjections),
          owner: null,
          result,
          syncKey,
          skipped: false,
        };
        return this.last;
      }

      const goal = (goals || []).find((entry) => !conversationIdOf(entry)) || null;
      const plan = (plans || []).find((entry) => !conversationIdOf(entry)) || null;
      if (!goal) {
        this.ownerRebindRequest = null;
        if (this.owner) {
          this.owner = null;
          try { await this.ownerStore?.save(null); } catch {}
        }
      } else {
        const rebind = this.ownerRebindRequest;
        if (rebind && rebind.goalId !== goal.id) {
          this.ownerRebindRequest = null;
        }
        if (this.ownerRebindRequest?.goalId === goal.id && this.resolveOwner) {
          let rebound = null;
          try { rebound = normalizeOverlayOwner(await this.resolveOwner(goal)); } catch {}
          if (rebound?.goalId === goal.id) {
            this.owner = rebound;
            this.ownerRebindRequest = null;
            try { await this.ownerStore?.save(this.owner); } catch {}
          }
        } else if (!this.owner || this.owner.goalId !== goal.id) {
          let resolved = null;
          if (this.resolveOwner) {
            try { resolved = await this.resolveOwner(goal); } catch {}
          }
          this.owner = normalizeOverlayOwner(resolved);
          try { await this.ownerStore?.save(this.owner); } catch {}
        }
      }
      const projection = normalizeClassicHostOverlayProjection({ goal, plan });
      const adapterStatus = typeof this.adapter.status === "function" ? this.adapter.status() : null;
      const syncKey = overlayProjectionSyncKey(projection, this.owner, adapterStatus);
      if (this.last?.syncKey === syncKey) {
        let domCurrent = true;
        if (this.owner?.runtimeKey && typeof this.adapter.inspect === "function") {
          try {
            const inspected = await this.adapter.inspect(this.owner.runtimeKey);
            domCurrent = Boolean(
              inspected?.mounted
              && inspected?.mode === "chat"
              && inspected?.conversationId === this.owner.conversationId
              && inspected?.goalRevision === (projection.goal?.revision ?? null)
              && inspected?.planRevision === (projection.plan?.revision ?? null)
            );
          } catch {
            domCurrent = false;
          }
        }
        if (domCurrent) {
          this.last = { ...this.last, projection, owner: this.owner, skipped: true };
          return this.last;
        }
      }
      const result = await this.adapter.syncAll(projection, { owner: this.owner });
      this.last = { projection, owner: this.owner, result, syncKey, skipped: false };
      return this.last;
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async requestOwnerRebind({ goalId } = {}) {
    const requestedGoalId = cleanProjectionText(goalId, 120);
    const currentGoalId = cleanProjectionText(this.last?.projection?.goal?.id, 120);
    if (!requestedGoalId || !currentGoalId || requestedGoalId !== currentGoalId) return false;
    this.ownerRebindRequest = {
      goalId: requestedGoalId,
      requestedAt: Date.now(),
    };
    return true;
  }

  async noteVerifiedRollover({ goalId, runtimeKey, oldConversationId, newConversationId } = {}) {
    const current = this.owner;
    const nextGoalId = cleanProjectionText(goalId, 120);
    const nextRuntimeKey = cleanProjectionText(runtimeKey, 80);
    const priorConversationId = cleanProjectionText(oldConversationId, 180);
    const nextConversationId = cleanProjectionText(newConversationId, 180);
    if (!current || !nextGoalId || !nextRuntimeKey || !priorConversationId || !nextConversationId) return false;
    if (current.goalId !== nextGoalId || current.runtimeKey !== nextRuntimeKey) return false;
    if (current.conversationId === nextConversationId) return true;
    if (current.conversationId !== priorConversationId) return false;
    this.owner = { ...current, conversationId: nextConversationId };
    try { await this.ownerStore?.save(this.owner); } catch {}
    return true;
  }

  status() {
    return this.last;
  }

  async close() {
    if (this.closed) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.syncing) await this.syncing.catch(() => {});
    const projection = normalizeClassicHostOverlayProjection();
    try {
      const result = this.last?.mode === "conversation-bound" && typeof this.adapter.syncConversationMap === "function"
        ? await this.adapter.syncConversationMap({})
        : await this.adapter.syncAll(projection);
      this.last = { projection, result };
    } catch {}
    this.closed = true;
  }
}

export { OVERLAY_ROOT_ID, OVERLAY_SCHEMA_VERSION };
