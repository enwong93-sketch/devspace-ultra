const ROLE_DEFS = Object.freeze({
  worker: Object.freeze({
    runtimeIdPrefix: "worker",
    labelPrefix: "Runtime",
    packageSuffix: "Worker",
    displayNamePrefix: "ChatGPT Worker",
    applicationId: "DevSpaceWorker",
    aliasPrefix: "chatgpt-classic-worker",
    runtimeRootName: "ChatGPT-Classic-Worker-Runtimes",
    visibleInAppList: false,
    workerManaged: true,
  }),
  interactive: Object.freeze({
    runtimeIdPrefix: "interactive",
    labelPrefix: "Main",
    packageSuffix: "Interactive",
    displayNamePrefix: "ChatGPT Main",
    applicationId: "DevSpaceInteractive",
    aliasPrefix: "chatgpt-classic-main",
    runtimeRootName: "ChatGPT-Classic-Interactive-Runtimes",
    visibleInAppList: true,
    workerManaged: false,
  }),
});

function validateNumber(role, number) {
  if (!Number.isInteger(number) || number < 1 || number > 32) {
    throw new Error("runtime number must be an integer between 1 and 32");
  }
  if (role === "interactive" && number === 1) {
    throw new Error("Main-01 is the canonical Primary and cannot be provisioned as a secondary interactive runtime");
  }
}

export function classicRuntimeIdentity({ role, number }) {
  const def = ROLE_DEFS[role];
  if (!def) throw new Error(`unsupported runtime role: ${String(role)}`);
  validateNumber(role, number);
  const padded = String(number).padStart(2, "0");
  return {
    role,
    number,
    runtimeId: `${def.runtimeIdPrefix}-${padded}`,
    label: `${def.labelPrefix}-${padded}`,
    packageName: `OpenAI.ChatGPT-Desktop.${def.packageSuffix}${padded}`,
    displayName: `${def.displayNamePrefix} ${padded}`,
    applicationId: def.applicationId,
    aliasName: `${def.aliasPrefix}${padded}.exe`,
    runtimeRootName: def.runtimeRootName,
    visibleInAppList: def.visibleInAppList,
    workerManaged: def.workerManaged,
  };
}

export function isWorkerManagedRole(role) {
  const def = ROLE_DEFS[role];
  if (!def) throw new Error(`unsupported runtime role: ${String(role)}`);
  return def.workerManaged;
}
