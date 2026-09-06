import assert from "node:assert/strict";
import { ToolCatalogRegistry, instrumentToolRegistration } from "./tool-catalog.js";

const catalog = new ToolCatalogRegistry();
const registered = [];
const server = {
  registerTool(name, definition, handler) {
    registered.push({ name, definition, handler });
    return { name };
  },
};
instrumentToolRegistration(server, catalog);
server.registerTool("read", {
  title: "Read file",
  description: "Read text from a workspace file.",
  annotations: { readOnlyHint: true, destructiveHint: false, ignored: "x" },
}, () => {});
server.registerTool("exec_command", {
  title: "Execute command",
  description: "Run a local process inside the selected workspace.",
}, () => {});
server.registerTool("view_image", {
  title: "View image",
  description: "Load a workspace image into model context.",
}, () => {});

assert.equal(registered.length, 3);
assert.deepEqual(catalog.search("image", { limit: 5 }).map((entry) => entry.name), ["view_image"]);
assert.equal(catalog.search("read workspace", { limit: 5 })[0].name, "read");
assert.equal(catalog.search("exec", { limit: 5 })[0].name, "exec_command");
assert.deepEqual(catalog.search("", { limit: 2 }).map((entry) => entry.name), ["exec_command", "read"]);
assert.deepEqual(catalog.list().find((entry) => entry.name === "read").annotations, {
  readOnlyHint: true,
  destructiveHint: false,
});
assert.throws(
  () => server.registerTool("read", { description: "duplicate" }, () => {}),
  /Duplicate tool registration/,
);
assert.equal(registered.length, 3, "duplicate must fail before reaching the underlying server");
assert.equal(catalog.diagnostics().count, 3);
assert.deepEqual(catalog.diagnostics().names, ["exec_command", "read", "view_image"]);

const failingCatalog = new ToolCatalogRegistry();
const failingServer = {
  registerTool() { throw new Error("underlying failure"); },
};
instrumentToolRegistration(failingServer, failingCatalog);
assert.throws(() => failingServer.registerTool("broken", {}, () => {}), /underlying failure/);
assert.equal(failingCatalog.diagnostics().count, 0, "failed registration must not leave a phantom catalog entry");

console.log(JSON.stringify({
  ok: true,
  gate: "tool-catalog",
  duplicateRegistrationFailsClosed: true,
  progressiveSearch: true,
}));
