export function incrementBoundedCounter(record, key, { limit = 64, maxKeyLength = 512 } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Bounded diagnostic counter requires a mutable object.");
  }
  const normalizedLimit = Math.max(1, Math.min(1024, Number(limit) || 64));
  const normalizedKey = String(key ?? "").slice(0, Math.max(1, Math.min(4096, Number(maxKeyLength) || 512)));
  if (!normalizedKey) return 0;
  if (!Object.hasOwn(record, normalizedKey)) {
    const keys = Object.keys(record);
    while (keys.length >= normalizedLimit) {
      const oldest = keys.shift();
      if (oldest !== undefined) delete record[oldest];
    }
    record[normalizedKey] = 0;
  }
  record[normalizedKey] = Math.max(0, Number(record[normalizedKey]) || 0) + 1;
  return record[normalizedKey];
}
