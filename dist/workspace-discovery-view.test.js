import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { workspaceDiscoveryView } from './workspace-discovery-view.js';
const input = {
  availableAgentsFiles: Array.from({ length: 1200 }, (_, i) => ({ path: `.local/fixtures/${i}/plugins/demo/AGENTS.md` })),
  skills: Array.from({ length: 300 }, (_, i) => ({ name: `skill-${i}`, path: `~/.agents/skills/skill-${i}/SKILL.md`, description: 'x'.repeat(400) })),
  agents: [], skillDiagnostics: [],
};
input.availableAgentsFiles.push({ path: 'src/AGENTS.md' }, { path: 'docs/CLAUDE.md' });
const before = JSON.stringify(input);
const view = workspaceDiscoveryView(input);
assert.equal(JSON.stringify(input), before, 'never mutate or delete the full inventory');
assert.equal(view.availableAgentsFiles[0].path, 'src/AGENTS.md');
assert.equal(view.counts.nestedInstructions.total, 1202);
assert.equal(view.skills.length, 12);
assert.ok(JSON.stringify(view).length < 20000);
assert.match(view.notice, /FULL trusted skill inventory/);
assert.match(view.notice, /ancestor AGENTS.md\/CLAUDE.md/);
assert.deepEqual(workspaceDiscoveryView({}).skills, []);
const huge = workspaceDiscoveryView({ skills: [{ name: 'huge', description: 'x'.repeat(1000000) }] });
assert.equal(huge.skills.length, 0);
assert.equal(huge.counts.skills.total, 1);
const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
assert.match(source, /workspaceDiscoveryView\(/, 'real open_workspace must use the bounded view');
assert.match(source, /agentsFiles:\s*loadedAgentsFiles/, 'full applicable root instructions must remain');
assert.match(source, /skills:\s*discovery\.skills/, 'only the response is bounded, not WorkspaceRegistry');
console.log(JSON.stringify({ ok: true, gate: 'workspace-discovery-view', optionalPreviewBounded: true, fullInventoryUnchanged: true }));
