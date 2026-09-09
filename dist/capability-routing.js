import { createHash } from "node:crypto";

export const ROUTING_CONTRACT_VERSION = "1";

const MAX_QUERY_CHARS = 2_000;
const MAX_FIELD_CHARS = 4_096;
const MAX_CANDIDATES = 1_000;
const MAX_RESULTS = 50;
const MAX_ARRAY_ITEMS = 64;
const EXPOSURES = new Set(["direct", "deferred", "explicit-only", "hidden"]);
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from", "how", "i", "in", "is", "it",
  "me", "my", "of", "on", "or", "please", "that", "the", "this", "to", "use", "we", "what", "when",
  "where", "which", "with", "you", "your", "幫", "幫我", "一下", "一個", "呢個", "嗰個", "可以", "需要", "想", "用",
]);

function boundedText(value, max = MAX_FIELD_CHARS) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);
}

function boundedArray(value, maxItems = MAX_ARRAY_ITEMS, maxChars = MAX_FIELD_CHARS) {
  const source = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const text = boundedText(item, maxChars);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

function phrase(value) {
  return boundedText(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}$]+/gu, " ").trim();
}

function cjkNgrams(token) {
  const chars = [...token];
  if (chars.length < 2 || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token)) return [];
  const result = [];
  for (const width of [2, 3]) {
    for (let index = 0; index + width <= chars.length; index += 1) result.push(chars.slice(index, index + width).join(""));
  }
  return result;
}

function terms(value, { keepStopWords = false } = {}) {
  const normalized = phrase(value).slice(0, MAX_QUERY_CHARS);
  const result = [];
  const seen = new Set();
  for (const token of normalized.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || []) {
    const parts = [token, ...token.split(/[-_]+/), ...cjkNgrams(token)];
    for (const raw of parts) {
      const term = raw.trim();
      if (!term || (!keepStopWords && STOP_WORDS.has(term)) || seen.has(term)) continue;
      seen.add(term);
      result.push(term);
      if (result.length >= 96) return result;
    }
  }
  return result;
}

function clampNumber(value, fallback = 0, min = -100, max = 100) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function normalizeRoutingPolicy(value = {}, defaults = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const fallback = defaults && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {};
  const implicit = source.allowImplicitInvocation
    ?? source.allow_implicit_invocation
    ?? fallback.allowImplicitInvocation
    ?? fallback.allow_implicit_invocation
    ?? true;
  const requestedExposure = boundedText(source.exposure ?? fallback.exposure ?? "deferred", 40).toLowerCase();
  const exposure = implicit === false
    ? "explicit-only"
    : EXPOSURES.has(requestedExposure) ? requestedExposure : "deferred";
  return {
    aliases: boundedArray([
      ...(Array.isArray(fallback.aliases) ? fallback.aliases : []),
      ...(Array.isArray(source.aliases) ? source.aliases : []),
      ...(Array.isArray(source.routingAliases) ? source.routingAliases : []),
      ...(Array.isArray(source.routing_aliases) ? source.routing_aliases : []),
      ...(Array.isArray(source.triggers) ? source.triggers : []),
      ...(Array.isArray(source.include) ? source.include : []),
    ]),
    negativeTriggers: boundedArray([
      ...(Array.isArray(fallback.negativeTriggers) ? fallback.negativeTriggers : []),
      ...(Array.isArray(source.negativeTriggers) ? source.negativeTriggers : []),
      ...(Array.isArray(source.negative_triggers) ? source.negative_triggers : []),
      ...(Array.isArray(source.exclude) ? source.exclude : []),
      ...(Array.isArray(source.notFor) ? source.notFor : []),
      ...(Array.isArray(source.not_for) ? source.not_for : []),
    ]),
    allowImplicitInvocation: implicit !== false,
    exposure,
    priority: clampNumber(source.priority ?? fallback.priority, 0),
  };
}

function normalizeCandidate(candidate = {}) {
  const routeId = boundedText(candidate.routeId, 300);
  const kind = boundedText(candidate.kind || "plugin", 80).toLowerCase();
  const name = boundedText(candidate.name, 220);
  if (!routeId || !name) return null;
  const policy = normalizeRoutingPolicy(candidate.routing, {
    aliases: candidate.aliases,
    negativeTriggers: candidate.negativeTriggers,
    allowImplicitInvocation: candidate.allowImplicitInvocation,
    exposure: candidate.exposure,
    priority: candidate.priority,
  });
  return {
    routeId,
    kind,
    name,
    title: boundedText(candidate.title || candidate.displayName || name, 300),
    description: boundedText(candidate.description, 2_000),
    shortDescription: boundedText(candidate.shortDescription, 800),
    pluginId: boundedText(candidate.pluginId, 180) || null,
    serverId: boundedText(candidate.serverId, 220) || null,
    toolName: boundedText(candidate.toolName, 220) || null,
    promptName: boundedText(candidate.promptName, 220) || null,
    resourceUri: boundedText(candidate.resourceUri, 2_048) || null,
    path: boundedText(candidate.path, 2_048) || null,
    aliases: policy.aliases,
    negativeTriggers: policy.negativeTriggers,
    defaultPrompts: boundedArray(candidate.defaultPrompts, 16, 1_000),
    dependencies: boundedArray(candidate.dependencies, 32, 800),
    allowImplicitInvocation: policy.allowImplicitInvocation,
    exposure: policy.exposure,
    priority: policy.priority,
    available: candidate.available !== false,
    availabilityReason: boundedText(candidate.availabilityReason, 500) || null,
    requires: boundedArray(candidate.requires, 16, 300),
    nextAction: candidate.nextAction && typeof candidate.nextAction === "object"
      ? canonicalize(candidate.nextAction)
      : null,
  };
}

function fieldRecord(name, value, weight) {
  const text = boundedArray(value).join(" ");
  return { name, text: phrase(text), terms: new Set(terms(text, { keepStopWords: true })), weight };
}

function exactMatch(queryPhrase, candidate) {
  const names = [candidate.name, candidate.title, candidate.routeId, candidate.pluginId, candidate.toolName, candidate.promptName]
    .map(phrase)
    .filter((item) => item.length >= 2);
  return names.some((item) => (
    queryPhrase === item
    || queryPhrase.includes(`$${item}`)
    || queryPhrase.includes(`skill ${item}`)
    || queryPhrase.includes(`plugin ${item}`)
    || queryPhrase.includes(`tool ${item}`)
  ));
}

function negativeMatch(queryPhrase, candidate) {
  for (const trigger of candidate.negativeTriggers) {
    const value = phrase(trigger);
    if (value && queryPhrase.includes(value)) return trigger;
  }
  return null;
}

const KIND_BONUS = Object.freeze({
  workflow: 72,
  runtime: 68,
  skill: 64,
  "mcp-tool": 18,
  "command-tool": 18,
  "mcp-prompt": 14,
  "mcp-resource": 8,
  "mcp-server": 3,
  plugin: 0,
  "host-app": -4,
});

function scoreCandidate(queryPhrase, queryTerms, candidate) {
  const explicit = exactMatch(queryPhrase, candidate);
  const negativeTrigger = explicit ? null : negativeMatch(queryPhrase, candidate);
  const fields = [
    fieldRecord("name", [candidate.name, candidate.toolName, candidate.promptName], 32),
    fieldRecord("title", candidate.title, 18),
    fieldRecord("aliases", candidate.aliases, 16),
    fieldRecord("shortDescription", candidate.shortDescription, 10),
    fieldRecord("defaultPrompts", candidate.defaultPrompts, 9),
    fieldRecord("dependencies", candidate.dependencies, 8),
    fieldRecord("description", candidate.description, 4),
    fieldRecord("plugin", candidate.pluginId, 3),
  ];
  let score = explicit ? 220 : 0;
  const matchedFields = new Set();
  let matchedTerms = 0;
  for (const queryTerm of queryTerms) {
    let best = 0;
    let bestField = null;
    for (const field of fields) {
      let contribution = 0;
      if (field.terms.has(queryTerm)) contribution = field.weight;
      else if (queryTerm.length >= 3 && field.text.includes(queryTerm)) contribution = Math.max(1, Math.round(field.weight * 0.55));
      if (contribution > best) {
        best = contribution;
        bestField = field.name;
      }
    }
    if (best > 0) {
      score += best;
      matchedTerms += 1;
      matchedFields.add(bestField);
    }
  }
  const aliases = [candidate.name, candidate.title, ...candidate.aliases, ...candidate.defaultPrompts]
    .map(phrase)
    .filter((value) => value.length >= 3);
  for (const value of aliases) {
    if (queryPhrase.includes(value) || value.includes(queryPhrase)) {
      score += value === phrase(candidate.name) ? 60 : 24;
      matchedFields.add(value === phrase(candidate.name) ? "name" : "phrase");
      break;
    }
  }
  const coverage = queryTerms.length ? matchedTerms / queryTerms.length : 0;
  score += Math.round(coverage * 24);
  score += candidate.priority;
  score += KIND_BONUS[candidate.kind] ?? 0;
  if (!explicit && matchedTerms === 0 && matchedFields.size === 0) score = 0;

  let blockedReason = null;
  if (candidate.exposure === "hidden") blockedReason = "hidden-route";
  else if (!candidate.available) blockedReason = candidate.availabilityReason || "route-unavailable";
  else if (!candidate.allowImplicitInvocation && !explicit) blockedReason = "explicit-invocation-required";
  else if (negativeTrigger) blockedReason = `excluded-by:${negativeTrigger}`;

  return {
    ...candidate,
    score: Math.max(0, Math.round(score)),
    coverage: Number(coverage.toFixed(3)),
    explicitMatch: explicit,
    matchedFields: [...matchedFields],
    eligible: !blockedReason,
    blockedReason,
  };
}

export function rankCapabilityRoutes(query, candidates, { limit = 8 } = {}) {
  const queryText = boundedText(query, MAX_QUERY_CHARS);
  const queryPhrase = phrase(queryText);
  let queryTerms = terms(queryText);
  if (!queryTerms.length) queryTerms = terms(queryText, { keepStopWords: true });
  const normalized = (Array.isArray(candidates) ? candidates : [])
    .slice(0, MAX_CANDIDATES)
    .map(normalizeCandidate)
    .filter(Boolean)
    .map((candidate) => scoreCandidate(queryPhrase, queryTerms, candidate))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => (
      Number(right.eligible) - Number(left.eligible)
      || right.score - left.score
      || Number(right.explicitMatch) - Number(left.explicitMatch)
      || left.routeId.localeCompare(right.routeId)
    ));
  const boundedLimit = Math.max(1, Math.min(MAX_RESULTS, Number(limit) || 8));
  const results = normalized.slice(0, boundedLimit);
  const eligible = results.filter((candidate) => candidate.eligible);
  const primary = eligible[0] || null;
  const second = eligible[1] || null;
  const ambiguous = Boolean(
    primary
    && second
    && !primary.explicitMatch
    && !second.explicitMatch
    && second.score >= Math.max(1, primary.score * 0.88)
  );
  return {
    version: ROUTING_CONTRACT_VERSION,
    query: queryText,
    queryTerms,
    primary,
    candidates: results,
    ambiguous,
    candidateCount: results.length,
    eligibleCount: eligible.length,
  };
}

export function capabilityRoutingFingerprint(candidates) {
  const normalized = (Array.isArray(candidates) ? candidates : [])
    .slice(0, MAX_CANDIDATES)
    .map(normalizeCandidate)
    .filter(Boolean)
    .sort((left, right) => left.routeId.localeCompare(right.routeId))
    .map((candidate) => ({
      routeId: candidate.routeId,
      kind: candidate.kind,
      name: candidate.name,
      title: candidate.title,
      description: candidate.description,
      shortDescription: candidate.shortDescription,
      pluginId: candidate.pluginId,
      serverId: candidate.serverId,
      toolName: candidate.toolName,
      promptName: candidate.promptName,
      resourceUri: candidate.resourceUri,
      path: candidate.path,
      aliases: candidate.aliases,
      negativeTriggers: candidate.negativeTriggers,
      defaultPrompts: candidate.defaultPrompts,
      dependencies: candidate.dependencies,
      allowImplicitInvocation: candidate.allowImplicitInvocation,
      exposure: candidate.exposure,
      priority: candidate.priority,
      available: candidate.available,
      availabilityReason: candidate.availabilityReason,
      requires: candidate.requires,
      nextAction: candidate.nextAction,
    }));
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ version: ROUTING_CONTRACT_VERSION, candidates: normalized })))
    .digest("hex");
}
