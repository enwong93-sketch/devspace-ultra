export const DEVSPACE_EXECUTION_POLICY = Object.freeze({
  mode: "danger-full-access",
  approvalPolicy: "never",
  sandboxEnabled: false,
  alternativeModes: Object.freeze([]),
  ownerSelected: true,
  scope: "single-user-local-workspace",
});

export function executionPolicySnapshot() {
  return {
    mode: DEVSPACE_EXECUTION_POLICY.mode,
    approvalPolicy: DEVSPACE_EXECUTION_POLICY.approvalPolicy,
    sandboxEnabled: DEVSPACE_EXECUTION_POLICY.sandboxEnabled,
    alternativeModes: [],
    ownerSelected: true,
    scope: DEVSPACE_EXECUTION_POLICY.scope,
  };
}
