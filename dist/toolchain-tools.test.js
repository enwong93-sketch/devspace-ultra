import assert from "node:assert/strict";
import { registerToolchainTools } from "./toolchain-tools.js";

const registrations = [];
const server = {
  registerTool(name, definition, handler) {
    registrations.push({ name, definition, handler });
  },
};
registerToolchainTools(server, {
  toolchainStatus: async (input) => ({ ok: true, kind: "status", input }),
  installToolchain: async (input) => ({ ok: true, kind: "install", input }),
});
assert.deepEqual(registrations.map((entry) => entry.name), ["toolchain_status", "toolchain_install"]);
assert.equal(registrations[0].definition.annotations.readOnlyHint, true);
assert.equal(registrations[1].definition.annotations.openWorldHint, true);

const status = await registrations[0].handler({ ids: ["git"], tiers: [] });
assert.equal(status.structuredContent.kind, "status");
assert.equal(status.isError, undefined);
const install = await registrations[1].handler({ ids: ["jq"], tiers: [], apply: false });
assert.equal(install.structuredContent.kind, "install");

const failing = [];
registerToolchainTools({ registerTool(name, definition, handler) { failing.push({ name, handler }); } }, {
  toolchainStatus: async () => { throw new Error("probe failed"); },
  installToolchain: async () => { throw new Error("install failed"); },
});
const failed = await failing[0].handler({ ids: [], tiers: [] });
assert.equal(failed.isError, true);
assert.equal(failed.structuredContent.ok, false);
assert.match(failed.structuredContent.error, /probe failed/);

console.log(JSON.stringify({
  ok: true,
  gate: "toolchain-tools",
  toolCount: registrations.length,
  structuredResults: true,
  failuresExplicit: true,
}));
