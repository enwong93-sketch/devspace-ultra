const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function boundedPositive(value, fallback, label) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive.`);
  return number;
}

function activeCounts(status) {
  return {
    admissionActive: Math.max(0, Number(status?.admission?.activeRequests || 0)),
    sessionActive: Math.max(0, Number(status?.sessions?.totalActiveRequests || 0)),
  };
}

export async function waitForStableGatewayQuiet({
  statusProbe,
  pollMs = 250,
  consecutiveQuietSamples = 2,
  signal,
} = {}) {
  if (typeof statusProbe !== "function") throw new Error("statusProbe is required.");
  const poll = boundedPositive(pollMs, 250, "pollMs");
  const requiredQuiet = Math.max(1, Math.floor(boundedPositive(consecutiveQuietSamples, 2, "consecutiveQuietSamples")));
  let quietSamples = 0;
  let lastAdmissionActive = null;
  let lastSessionActive = null;

  while (true) {
    if (signal?.aborted) {
      return {
        ok: false,
        state: "cancelled",
        quietSamples,
        lastAdmissionActive,
        lastSessionActive,
      };
    }
    try {
      const status = await statusProbe();
      const counts = activeCounts(status);
      lastAdmissionActive = counts.admissionActive;
      lastSessionActive = counts.sessionActive;
      if (counts.admissionActive === 0 && counts.sessionActive === 0) {
        quietSamples += 1;
        if (quietSamples >= requiredQuiet) {
          return {
            ok: true,
            state: "quiet",
            quietSamples,
            lastAdmissionActive,
            lastSessionActive,
          };
        }
      } else {
        quietSamples = 0;
      }
    } catch {
      quietSamples = 0;
    }
    await sleep(poll);
  }
}
