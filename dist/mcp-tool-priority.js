const DEFAULT_PRIORITY = Object.freeze([
  "open_workspace",
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "grep",
  "glob",
  "ls",
  "bash",
  "devspace_progress_report",
  "devspace_plan_start",
  "devspace_plan_status",
  "devspace_plan_mount",
  "devspace_update_plan",
  "devspace_goal_start",
  "devspace_goal_status",
  "devspace_goal_round_begin",
  "devspace_goal_turn_report",
  "devspace_goal_complete",
  "devspace_goal_blocked",
  "devspace_goal_control",
  "devspace_goal_mount",
  "devspace_route",
  "tool_search",
  "capability_connection",
  "capability_route",
  "capability_search",
  "capability_inspect",
  "capability_call",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function entriesFor(value) {
  if (value instanceof Map) return [...value.entries()];
  if (isPlainObject(value)) return Object.entries(value);
  return [];
}

function locateToolContainer(server, priorityNames) {
  const wanted = new Set(priorityNames);
  let best = null;
  for (const property of Reflect.ownKeys(server)) {
    const value = server[property];
    const entries = entriesFor(value);
    if (!entries.length) continue;
    const keys = entries.map(([name]) => String(name));
    const overlap = keys.filter((name) => wanted.has(name)).length;
    if (!best || overlap > best.overlap || (overlap === best.overlap && entries.length > best.entries.length)) {
      best = { property, value, entries, keys, overlap };
    }
  }
  if (!best || best.overlap < 3) {
    throw new Error("Unable to locate the MCP registered-tool container for priority ordering.");
  }
  return best;
}

function orderedEntries(entries, priorityNames) {
  const byName = new Map(entries.map((entry) => [String(entry[0]), entry]));
  const ordered = [];
  for (const name of priorityNames) {
    const entry = byName.get(name);
    if (!entry) continue;
    ordered.push(entry);
    byName.delete(name);
  }
  for (const entry of entries) {
    const name = String(entry[0]);
    if (!byName.has(name)) continue;
    ordered.push(entry);
    byName.delete(name);
  }
  return ordered;
}

export function prioritizeMcpTools(server, priorityNames = DEFAULT_PRIORITY) {
  if (!server || typeof server !== "object") throw new TypeError("MCP server is required.");
  const names = [...new Set(priorityNames.map((name) => String(name).trim()).filter(Boolean))];
  const container = locateToolContainer(server, names);
  const ordered = orderedEntries(container.entries, names);
  if (container.value instanceof Map) {
    container.value.clear();
    for (const [name, descriptor] of ordered) container.value.set(name, descriptor);
  } else {
    for (const [name] of container.entries) delete container.value[name];
    for (const [name, descriptor] of ordered) container.value[name] = descriptor;
  }
  const finalNames = entriesFor(container.value).map(([name]) => String(name));
  const prioritized = names.filter((name) => finalNames.includes(name));
  return {
    ok: true,
    containerProperty: String(container.property),
    toolCount: finalNames.length,
    prioritized,
    firstTools: finalNames.slice(0, Math.max(32, prioritized.length)),
  };
}

export { DEFAULT_PRIORITY as DEFAULT_MCP_TOOL_PRIORITY };
