import { readFileSync } from "node:fs";
import { installGoalRelayAppBridge } from "./goal-relay-app-bridge.js";

export const GOAL_RELAY_URI = "ui://devspace/goal-continuation-relay-v2.html";
export const PROGRESS_CLAIM_RELAY_URI = "ui://devspace/progress-claim-relay-v2.html";

export function readGoalRelayHtml(filename) {
  if (!["goal-continuation-relay.html", "progress-claim-relay.html"].includes(filename)) {
    throw new Error("Unknown Goal relay resource");
  }
  return readFileSync(new URL(`./ui/${filename}`, import.meta.url), "utf8")
    .replace("/*__DEVSPACE_RELAY_APP_BRIDGE__*/", `const relayBridge = (${installGoalRelayAppBridge.toString()})(window);`);
}
