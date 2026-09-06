#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GoalRuntime } from "../dist/goal-runtime.js";
import { ClassicConversationAuthorityRegistry } from "../dist/classic-conversation-authority.js";
import { validateNativeGoalBinding } from "../dist/native-binding-evidence.js";
import { loadConfig } from "../dist/config.js";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? String(process.argv[index + 1]) : fallback;
}

const configDir = resolve(argument("config-dir", join(homedir(), ".devspace-tailscale-bootstrap")));
const goalId = argument("goal-id", "goal_1b2f3eb499d8f460").trim();
if (!/^goal_[A-Za-z0-9]+$/.test(goalId)) throw new Error("A valid --goal-id is required.");
const config = loadConfig({ ...process.env, DEVSPACE_CONFIG_DIR: configDir });
const goalRuntime = new GoalRuntime({ stateDir: config.stateDir });
const authority = new ClassicConversationAuthorityRegistry({
  statePath: join(config.stateDir, "classic-conversation-authority.json"),
});
try {
  await authority.load();
  const goals = await goalRuntime.activeGoals({ limit: 100 });
  const goal = goals.find((candidate) => candidate.id === goalId);
  if (!goal) throw new Error(`Active Goal ${goalId} was not found.`);
  const evidence = validateNativeGoalBinding(goal, authority.snapshot());
  console.log(JSON.stringify({
    ...evidence,
    gate: "native-goal-binding-live",
    configDir,
    source: "ClassicConversationAuthorityRegistry hashed native session correlation",
    rawSessionPersisted: false,
    urlOrDomAuthorityUsed: false,
  }, null, 2));
} finally {
  await goalRuntime.close();
  await authority.close?.();
}

if (process.argv[1] && resolve(process.argv[1]) !== resolve(fileURLToPath(import.meta.url))) {
  throw new Error("native-goal-binding-live-gate must be executed as a script.");
}
