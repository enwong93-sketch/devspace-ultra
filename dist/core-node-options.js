const PROFILES = Object.freeze({
  system: Object.freeze(["--expose-gc"]),
});

const LEGACY_UNBOUNDED_ALIASES = new Set(["bounded-512"]);

export function normalizeCoreHeapProfile(value = "system") {
  const profile = String(value || "system").trim().toLowerCase();
  if (LEGACY_UNBOUNDED_ALIASES.has(profile)) return "system";
  if (!Object.hasOwn(PROFILES, profile)) {
    throw new Error(`Invalid Stable Gateway Core heap profile: ${value}. Production accepts only system-managed heap sizing.`);
  }
  return profile;
}

export function nodeArgsForCoreHeapProfile(value = "system") {
  const profile = normalizeCoreHeapProfile(value);
  return [...PROFILES[profile]];
}

export function validateCoreNodeArgs(args = [], { allowDiagnosticGc = false } = {}) {
  if (!Array.isArray(args)) throw new Error("Core Node arguments must be an array.");
  const values = args.map(String);
  for (const argument of values) {
    if (allowDiagnosticGc && argument === "--expose-gc") continue;
    if (/^--(?:max-old-space-size|max-semi-space-size)=/i.test(argument)) {
      throw new Error(`Stable Gateway production Core memory caps are forbidden: ${argument}`);
    }
    throw new Error(`Unsupported Stable Gateway Core Node argument: ${argument}`);
  }
  return values;
}

export const CORE_HEAP_PROFILES = Object.freeze(Object.keys(PROFILES));
