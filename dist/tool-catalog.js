const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const MAX_DESCRIPTION_CHARS = 1_200;

function cleanText(value, max = MAX_DESCRIPTION_CHARS) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanToolName(value) {
  const name = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(name)) {
    throw new Error(`Invalid tool name: ${name || "<empty>"}`);
  }
  return name;
}

function normalizedAnnotations(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = {};
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    if (typeof value[key] === "boolean") result[key] = value[key];
  }
  return Object.keys(result).length ? result : undefined;
}

function queryTerms(query) {
  return String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 16);
}

function scoreEntry(entry, terms) {
  if (!terms.length) return 1;
  const name = entry.name.toLowerCase();
  const title = entry.title.toLowerCase();
  const description = entry.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 100;
    else if (name.startsWith(term)) score += 40;
    else if (name.includes(term)) score += 20;
    if (title.includes(term)) score += 8;
    if (description.includes(term)) score += 3;
  }
  return score;
}

export class ToolCatalogRegistry {
  constructor() {
    this.entriesByName = new Map();
  }

  register(nameValue, definition = {}, { source = "devspace-core" } = {}) {
    const name = cleanToolName(nameValue);
    if (this.entriesByName.has(name)) {
      const previous = this.entriesByName.get(name);
      throw new Error(`Duplicate tool registration: ${name} (already registered by ${previous.source}).`);
    }
    const entry = Object.freeze({
      name,
      title: cleanText(definition?.title ?? name, 240),
      description: cleanText(definition?.description),
      source: cleanText(source, 240) || "devspace-core",
      annotations: normalizedAnnotations(definition?.annotations),
    });
    this.entriesByName.set(name, entry);
    return entry;
  }

  unregister(nameValue) {
    return this.entriesByName.delete(String(nameValue ?? "").trim());
  }

  list() {
    return [...this.entriesByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  search(query, { limit = DEFAULT_SEARCH_LIMIT } = {}) {
    const max = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Number(limit) || DEFAULT_SEARCH_LIMIT));
    const terms = queryTerms(query);
    return this.list()
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, max)
      .map(({ entry }) => entry);
  }

  diagnostics() {
    return {
      count: this.entriesByName.size,
      names: this.list().map((entry) => entry.name),
    };
  }
}

export function instrumentToolRegistration(server, catalog, { source = "devspace-core" } = {}) {
  if (!server || typeof server.registerTool !== "function") throw new Error("MCP server registerTool is required.");
  if (!(catalog instanceof ToolCatalogRegistry)) throw new Error("ToolCatalogRegistry is required.");
  const original = server.registerTool.bind(server);
  server.registerTool = (name, definition, handler) => {
    catalog.register(name, definition, { source });
    try {
      return original(name, definition, handler);
    } catch (error) {
      catalog.unregister(name);
      throw error;
    }
  };
  return catalog;
}
