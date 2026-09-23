export function classifySupervisedGatewayExit({ code = null, signal = null, peerState = null } = {}) {
  if (peerState === "ready") {
    return { exitCode: 0, state: "peer-gateway-ready", unexpected: false };
  }
  const numeric = Number(code);
  return {
    exitCode: Number.isInteger(numeric) && numeric > 0 ? numeric : 1,
    state: "gateway-exited-unexpectedly",
    unexpected: true,
    signal: signal ? String(signal).slice(0, 40) : null,
  };
}
