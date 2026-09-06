function records(value, results = []) {
  if (!value || typeof value !== "object") return results;
  if (Array.isArray(value)) {
    for (const item of value) records(item, results);
    return results;
  }
  if (typeof value.conversationId === "string") results.push(value);
  for (const child of Object.values(value)) records(child, results);
  return results;
}

export function validateNativeGoalBinding(goal, authoritySnapshot) {
  if (!goal || typeof goal !== "object") throw new Error("Goal evidence is missing.");
  const conversationId = String(goal.conversationId || "").trim();
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(conversationId)) {
    throw new Error("Goal has no valid native conversation binding.");
  }
  const matches = records(authoritySnapshot)
    .filter((record) => record.conversationId === conversationId);
  if (!matches.length) throw new Error("Goal conversation is absent from the native authority registry.");
  const fingerprinted = matches.filter((record) => /^[a-f0-9]{64}$/i.test(String(record.sessionFingerprint || record.fingerprint || "")));
  if (!fingerprinted.length) throw new Error("Native authority record has no hashed session fingerprint.");
  const runtimeKeys = [...new Set(fingerprinted.flatMap((record) => {
    if (Array.isArray(record.runtimeKeys)) return record.runtimeKeys.map(String);
    if (record.runtimeKey) return [String(record.runtimeKey)];
    return [];
  }).filter(Boolean))];
  if (runtimeKeys.length > 1) throw new Error(`Native conversation binding is ambiguous across runtimes: ${runtimeKeys.join(", ")}`);
  return {
    ok: true,
    goalId: String(goal.id || ""),
    status: String(goal.status || ""),
    round: Number(goal.round || 0),
    revision: Number(goal.revision || 0),
    conversationId,
    sessionFingerprintPresent: true,
    runtimeKey: runtimeKeys[0] || null,
    authorityMatches: fingerprinted.length,
  };
}
