import assert from "node:assert/strict";
import {
  classicRuntimeIdentity,
  isWorkerManagedRole,
} from "./chat-classic-runtime-role.js";

const worker = classicRuntimeIdentity({ role: "worker", number: 2 });
assert.deepEqual(worker, {
  role: "worker",
  number: 2,
  runtimeId: "worker-02",
  label: "Runtime-02",
  packageName: "OpenAI.ChatGPT-Desktop.Worker02",
  displayName: "ChatGPT Worker 02",
  applicationId: "DevSpaceWorker",
  aliasName: "chatgpt-classic-worker02.exe",
  runtimeRootName: "ChatGPT-Classic-Worker-Runtimes",
  visibleInAppList: false,
  workerManaged: true,
});
assert.equal(isWorkerManagedRole("worker"), true);

const interactive = classicRuntimeIdentity({ role: "interactive", number: 2 });
assert.deepEqual(interactive, {
  role: "interactive",
  number: 2,
  runtimeId: "interactive-02",
  label: "Main-02",
  packageName: "OpenAI.ChatGPT-Desktop.Interactive02",
  displayName: "ChatGPT Main 02",
  applicationId: "DevSpaceInteractive",
  aliasName: "chatgpt-classic-main02.exe",
  runtimeRootName: "ChatGPT-Classic-Interactive-Runtimes",
  visibleInAppList: true,
  workerManaged: false,
});
assert.equal(isWorkerManagedRole("interactive"), false);

assert.throws(() => classicRuntimeIdentity({ role: "interactive", number: 1 }), /Main-01|canonical Primary/i);
assert.throws(() => classicRuntimeIdentity({ role: "primary", number: 1 }), /role/i);
assert.throws(() => classicRuntimeIdentity({ role: "worker", number: 0 }), /number/i);

console.log(JSON.stringify({ ok: true, roles: [worker.role, interactive.role] }));
