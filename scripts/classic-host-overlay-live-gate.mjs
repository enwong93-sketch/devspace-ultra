import assert from "node:assert/strict";
import { connectClassicHostOverlayPort } from "../dist/classic-host-overlay.js";

const port = Number(process.env.DEVSPACE_CLASSIC_HOST_OVERLAY_LIVE_PORT || 9733);
const expectedPlanRevision = process.env.DEVSPACE_CLASSIC_HOST_OVERLAY_EXPECT_PLAN_REVISION
  ? Number(process.env.DEVSPACE_CLASSIC_HOST_OVERLAY_EXPECT_PLAN_REVISION)
  : null;
const timeoutMs = Number(process.env.DEVSPACE_CLASSIC_HOST_OVERLAY_LIVE_TIMEOUT_MS || 15_000);
const expectedVisible = process.env.DEVSPACE_CLASSIC_HOST_OVERLAY_EXPECT_VISIBLE !== "0";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(inspect, predicate, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await inspect(); } catch {}
    if (last && predicate(last)) return last;
    await sleep(250);
  }
  throw new Error(`${label} timed out. Last state: ${JSON.stringify(last)}`);
}

function assertPlacement(snapshot, label) {
  assert.equal(snapshot.mode, "chat", `${label}: Work mode is not an acceptance surface`);
  assert.equal(snapshot.mounted, true, `${label}: overlay root must be mounted`);
  assert.equal(snapshot.rootCount, 1, `${label}: exactly one overlay root is allowed`);
  assert.equal(snapshot.goalCount, 1, `${label}: exactly one Goal strip is allowed`);
  assert.equal(snapshot.planCount, 1, `${label}: exactly one Plan HUD is allowed`);
  assert.equal(snapshot.goalVisible, true, `${label}: Goal strip must be visible`);
  assert.equal(snapshot.planVisible, true, `${label}: Plan HUD must be visible`);
  assert.ok(Number.isFinite(snapshot.goalGap) && snapshot.goalGap >= 4 && snapshot.goalGap <= 16,
    `${label}: Goal strip must sit directly above the composer; gap=${snapshot.goalGap}`);
  assert.ok(Number.isFinite(snapshot.planTop) && snapshot.planTop >= 48 && snapshot.planTop <= 110,
    `${label}: Plan HUD must stay at the conversation top-right; top=${snapshot.planTop}`);
  assert.ok(Number.isFinite(snapshot.planRight) && snapshot.planRight >= 0 && snapshot.planRight <= 40,
    `${label}: Plan HUD must stay at the conversation top-right; right=${snapshot.planRight}`);
  assert.ok(Number.isFinite(snapshot.goalRevision) && snapshot.goalRevision >= 1, `${label}: Goal revision must come from backend state`);
  assert.ok(Number.isFinite(snapshot.planRevision) && snapshot.planRevision >= 1, `${label}: Plan revision must come from backend state`);
  assert.match(snapshot.goalText, /Goal/i, `${label}: Goal projection must contain Goal state`);
  assert.match(snapshot.planText, /Plan/i, `${label}: Plan projection must contain Plan state`);
  if (Number.isFinite(expectedPlanRevision)) {
    assert.equal(snapshot.planRevision, expectedPlanRevision, `${label}: Plan HUD did not receive the expected backend revision`);
  }
}

function assertHidden(snapshot, label) {
  assert.equal(snapshot.mode, "chat", `${label}: Work mode is not an acceptance surface`);
  assert.equal(snapshot.mounted, false, `${label}: a non-owner Main/conversation must not mount the Goal/Plan projection`);
  assert.equal(snapshot.goalVisible, false, `${label}: non-owner Goal strip must stay hidden`);
  assert.equal(snapshot.planVisible, false, `${label}: non-owner Plan HUD must stay hidden`);
  assert.ok(snapshot.rootCount === 0 || snapshot.rootCount === 1, `${label}: hidden projection must not duplicate overlay roots`);
}

const session = await connectClassicHostOverlayPort(port);
if (!session) throw new Error(`ChatGPT Classic Main CDP port ${port} is not available.`);

try {
  const before = await waitFor(
    () => session.inspect(),
    (value) => value.mode === "chat" && (expectedVisible
      ? value.mounted && value.goalVisible && value.planVisible
      : !value.mounted && !value.goalVisible && !value.planVisible),
    expectedVisible ? "initial owner host overlay" : "initial non-owner hidden overlay",
  );
  if (expectedVisible) assertPlacement(before, "initial");
  else assertHidden(before, "initial");

  const beforeHref = before.href;
  const beforeGoalRevision = before.goalRevision;
  const beforePlanRevision = before.planRevision;
  const safeBoundary = await waitFor(
    () => session.inspect(),
    (value) => value.href === beforeHref
      && value.mode === "chat"
      && (expectedVisible ? value.mounted : !value.mounted)
      && value.goalRevision === beforeGoalRevision
      && value.planRevision === beforePlanRevision
      && value.generating === false
      && value.composerTextChars === 0,
    "safe reload boundary",
  );
  if (expectedVisible) assertPlacement(safeBoundary, "safe-boundary");
  else assertHidden(safeBoundary, "safe-boundary");

  await session.reload();
  const after = await waitFor(
    () => session.inspect(),
    (value) => value.href === beforeHref
      && value.mode === "chat"
      && (expectedVisible
        ? value.mounted && value.goalVisible && value.planVisible
        : !value.mounted && !value.goalVisible && !value.planVisible)
      && value.goalRevision === beforeGoalRevision
      && value.planRevision === beforePlanRevision,
    expectedVisible ? "post-reload owner host overlay" : "post-reload non-owner hidden overlay",
  );
  if (expectedVisible) assertPlacement(after, "post-reload");
  else assertHidden(after, "post-reload");
  assert.equal(after.href, beforeHref, "Reload acceptance must stay on the exact same URL.");
  assert.equal(after.goalRevision, beforeGoalRevision, "Goal backend revision changed merely because the renderer reloaded.");
  assert.equal(after.planRevision, beforePlanRevision, "Plan backend revision changed merely because the renderer reloaded.");

  console.log(JSON.stringify({
    ok: true,
    gate: "classic-host-overlay-live",
    port,
    conversationId: after.conversationId,
    href: after.href,
    viewport: { width: after.viewportWidth, height: after.viewportHeight },
    goal: { revision: after.goalRevision, gapPx: after.goalGap },
    plan: { revision: after.planRevision, topPx: after.planTop, rightPx: after.planRight },
    expectedVisible,
    rootCount: after.rootCount,
    sameUrlReload: true,
    noSyntheticUserMessage: true,
  }, null, 2));
} finally {
  await session.close();
}
