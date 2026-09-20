import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceRegistry } from './workspaces.js';
const root = await mkdtemp(join(tmpdir(), 'devspace-discovery-scan-'));
try {
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.local/fixture/plugins/a'), { recursive: true });
  await mkdir(join(root, '.tmp/copy'), { recursive: true });
  await writeFile(join(root, 'src/AGENTS.md'), 'Real source instructions');
  await writeFile(join(root, '.local/fixture/plugins/a/AGENTS.md'), 'Fixture data, not parent instructions');
  await writeFile(join(root, '.tmp/copy/AGENTS.md'), 'Temporary clone');
  const registry = new WorkspaceRegistry({ allowedRoots: [root] });
  const discovered = await registry.findAvailableAgentsFiles(root, []);
  assert.deepEqual(discovered.map(x => x.path), [join(root, 'src/AGENTS.md')]);
  const explicit = await registry.findAvailableAgentsFiles(join(root, '.local/fixture'), []);
  assert.equal(explicit.length, 1, 'explicit fixture workspace is not blocked from its own instructions');
  console.log(JSON.stringify({ ok: true, gate: 'workspace-discovery-scan', fixtureCatalogExcluded: true, explicitNestedWorkspaceRetained: true }));
} finally { await rm(root, { recursive: true, force: true }); }
