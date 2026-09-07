#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { AUTO_COMPACT_CONTRACT_DEFAULTS } from "../../../dist/auto-compact-contract.js";

async function readJson(path) {
  try { return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")); }
  catch { return null; }
}

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 64 * 1024) throw new Error("Auto Compact status input exceeded 64 KiB.");
  }
  if (!text.trim()) return {};
  const value = JSON.parse(text);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value, max = 300) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeCapsuleRecord(record, meta) {
  const capsule = record?.capsule || {};
  const continuity = capsule?.continuity || {};
  const compression = capsule?.compression || {};
  return {
    id: clean(record?.id || meta?.id, 200),
    createdAt: clean(record?.createdAt || meta?.createdAt, 80),
    status: clean(record?.status || meta?.status, 120),
    continuityKey: clean(record?.continuityKey || meta?.continuityKey, 300),
    continuity: {
      strategy: clean(continuity.strategy, 120),
      mode: clean(continuity.mode, 80),
      uiContinuityKey: clean(continuity.uiContinuityKey, 300),
      sourceConversationId: clean(continuity.sourceConversationId, 240),
      sourceBoundaryMessageId: clean(continuity.sourceBoundaryMessageId, 240),
      runtimeKey: clean(continuity.runtimeKey, 100),
      goalId: clean(continuity.goalId, 200),
      planId: clean(continuity.planId, 200),
      capsuleFingerprint: clean(continuity.capsuleFingerprint, 80),
    },
    compression: {
      strategy: clean(compression.strategy || continuity.strategy, 120),
      sourcePayloadBytes: Number.isSafeInteger(compression.sourcePayloadBytes) ? compression.sourcePayloadBytes : null,
      sourceBranchMessageCount: Number.isSafeInteger(compression.sourceBranchMessageCount) ? compression.sourceBranchMessageCount : null,
      sourceExactUsedTokens: Number.isSafeInteger(compression.sourceExactUsedTokens) ? compression.sourceExactUsedTokens : null,
      carryMessageCount: Number.isSafeInteger(compression.carryMessageCount) ? compression.carryMessageCount : null,
      carryBytes: Number.isSafeInteger(compression.carryBytes) ? compression.carryBytes : null,
      carryEstimatedTokens: Number.isSafeInteger(compression.carryEstimatedTokens) ? compression.carryEstimatedTokens : null,
      ratios: compression.ratios && typeof compression.ratios === "object" ? compression.ratios : {},
      maxCarryRatio: Number.isFinite(Number(compression.maxCarryRatio)) ? Number(compression.maxCarryRatio) : null,
      fullHistoryInherited: compression.fullHistoryInherited === true,
      zeroContextContinuation: compression.zeroContextContinuation === true,
      accepted: compression.accepted === true,
      preservedCategories: Array.isArray(compression.preservedCategories) ? compression.preservedCategories.slice(0, 40) : [],
      excludedCategories: Array.isArray(compression.excludedCategories) ? compression.excludedCategories.slice(0, 40) : [],
    },
    toConversationId: clean(record?.toConversationId || meta?.toConversationId, 240),
    verifiedAt: clean(record?.verifiedAt || meta?.verifiedAt, 80),
    error: clean(record?.error || meta?.error, 500),
  };
}

const input = await readInput();
const action = input.action === "latest" ? "latest" : "status";
const requestedContinuityKey = clean(input.continuityKey, 300);
const configDir = resolve(process.env.DEVSPACE_CONFIG_DIR || join(homedir(), ".devspace-tailscale-bootstrap"));
const config = await readJson(join(configDir, "config.json")) || {};
const stateDir = resolve(config.stableGatewayStateDir || config.edgeFixedStateDir || config.stateDir || join(homedir(), ".local", "share", "devspace-tailscale-bootstrap"));
const continuityDir = join(stateDir, "continuity");
const capsuleDir = join(continuityDir, "capsules");
const state = await readJson(join(continuityDir, "state.json")) || { capsules: {} };
const rows = Object.values(state.capsules || {})
  .filter((item) => !requestedContinuityKey || item?.continuityKey === requestedContinuityKey || item?.uiContinuityKey === requestedContinuityKey)
  .sort((left, right) => String(right?.createdAt || "").localeCompare(String(left?.createdAt || "")));
let latest = null;
let inspectedCapsules = 0;
for (const meta of rows.slice(0, 64)) {
  if (!meta?.filePath || !inside(capsuleDir, meta.filePath)) continue;
  const record = await readJson(meta.filePath);
  inspectedCapsules += 1;
  const safe = record ? safeCapsuleRecord(record, meta) : null;
  if (safe?.compression?.accepted === true && safe?.compression?.strategy === "selective-hidden-capsule-continuation") {
    latest = safe;
    break;
  }
}

const result = {
  ok: true,
  action,
  product: "DevSpace Auto Compact",
  strategy: "selective-hidden-capsule-continuation",
  enabled: config.autoCompactEnabled === true,
  contextGuardianEnabled: config.contextGuardianEnabled === true,
  threshold: Number.isFinite(Number(config.contextGuardianThresholdPercent))
    ? Number(config.contextGuardianThresholdPercent) / 100
    : Number.isFinite(Number(config.autoCompactThreshold)) ? Number(config.autoCompactThreshold) : 0.90,
  uiContinuityAllowsBackendIdChange: true,
  fullHistoryInheritanceAllowed: false,
  zeroContextContinuationAllowed: false,
  policy: AUTO_COMPACT_CONTRACT_DEFAULTS,
  capsuleCount: rows.length,
  inspectedCapsules,
  latestSelectiveCapsuleAvailable: Boolean(latest),
  latest,
  stateDirReturned: false,
  rawCapsuleContentReturned: false,
  credentialsReturned: false,
};
console.log(JSON.stringify(action === "latest" ? { ok: true, action, latest, policy: result.policy } : result));
