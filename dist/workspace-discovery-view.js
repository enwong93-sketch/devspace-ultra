// Bound optional discovery metadata, not applicable instructions or execution.
// The full trusted inventories remain in WorkspaceRegistry for routing/reads.
function preview(items, limit, charBudget, compare) {
  const ordered = compare ? [...items].sort(compare) : items;
  const result = [];
  let chars = 2;
  for (const item of ordered) {
    const size = JSON.stringify(item).length + 1;
    if (result.length >= limit) break;
    if (chars + size > charBudget) continue;
    result.push(item); chars += size;
  }
  return result;
}
const generated = path => /(^|[\\/])(?:\.local|\.tmp|node_modules|\.git|\.cache)([\\/]|$)/.test(path || '');
export function workspaceDiscoveryView({ availableAgentsFiles = [], skills = [], agents = [], skillDiagnostics = [] } = {}) {
  const paths = preview(availableAgentsFiles, 24, 6000, (a, b) =>
    Number(generated(a.path)) - Number(generated(b.path)) || a.path.length - b.path.length || a.path.localeCompare(b.path));
  const selectedSkills = preview(skills, 12, 8000);
  const selectedAgents = preview(agents, 8, 4000);
  const diagnostics = preview(skillDiagnostics, 8, 2000);
  const counts = {
    nestedInstructions: { total: availableAgentsFiles.length, returned: paths.length },
    skills: { total: skills.length, returned: selectedSkills.length },
    agents: { total: agents.length, returned: selectedAgents.length },
    diagnostics: { total: skillDiagnostics.length, returned: diagnostics.length },
  };
  const omitted = Object.values(counts).some(x => x.total !== x.returned);
  const notice = omitted
    ? ` Discovery is a bounded preview, not the complete catalogue: ${Object.entries(counts).map(([name, x]) => `${name} ${x.returned}/${x.total}`).join('; ')}. Root/global applicable instructions are included in full. Use devspace_route with this workspaceId and the actual task to search the FULL trusted skill inventory, then devspace_skill_read for the selected skill. Before editing any nested path, inspect its ancestor AGENTS.md/CLAUDE.md files with read even if absent from this preview. Use scoped glob/read for additional instruction paths. Do not reopen the workspace to fetch the same catalogue. No skills, instruction files or execution capabilities were removed.`
    : '';
  return { availableAgentsFiles: paths, skills: selectedSkills, agents: selectedAgents,
    skillDiagnostics: diagnostics, counts, notice };
}
