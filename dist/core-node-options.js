const PROFILES = Object.freeze({
  system: Object.freeze([]),
  "bounded-512": Object.freeze([
    "--max-old-space-size=464",
    "--max-semi-space-size=16",
  ]),
});

const ALLOWED_ARGUMENT = /^--(?:max-old-space-size|max-semi-space-size)=\d+$/;

export function normalizeCoreHeapProfile(value = "system") {
  const profile = String(value || "system").trim().toLowerCase();
  if (!Object.hasOwn(PROFILES, profile)) {
    throw new Error(`Invalid Stable Gateway Core heap profile: ${value}. Expected ${Object.keys(PROFILES).join(" or ")}.`);
  }
  return profile;
}

export function nodeArgsForCoreHeapProfile(value = "system") {
  const profile = normalizeCoreHeapProfile(value);
  return [...PROFILES[profile]];
}

export function validateCoreNodeArgs(args = []) {
  if (!Array.isArray(args)) throw new Error("Core Node arguments must be an array.");
  const values = args.map(String);
  for (const argument of values) {
    if (!ALLOWED_ARGUMENT.test(argument)) {
      throw new Error(`Unsupported Stable Gateway Core Node argument: ${argument}`);
    }
  }
  return values;
}

export const CORE_HEAP_PROFILES = Object.freeze(Object.keys(PROFILES));
