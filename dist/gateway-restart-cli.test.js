import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseGatewayRestartArguments as parse } from './gateway-restart-cli.js';

test('restart mode is explicit and unknown or conflicting arguments fail closed', () => {
  assert.equal(parse([]).mode, 'help');
  for (const mode of ['status', 'preflight-only', 'execute', 'help']) assert.equal(parse(['--' + mode]).mode, mode);
  for (const args of [['--stats'], ['--status', '--execute'], ['--execute', '--delay-seconds', '-1'], ['--config-dir'], ['--task-name', 'x'], ['--execute', '--execute']]) assert.throws(() => parse(args));
});

test('actual --status reads the saved record without overwriting, spawning or configuring services', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devspace-restart-status-'));
  try {
    await mkdir(join(root, 'logs'));
    const path = join(root, 'logs', 'stable-gateway-whole-restart-result.json');
    const text = JSON.stringify({ state: 'verified-sentinel', ok: true });
    await writeFile(path, text); const before = await stat(path);
    const entry = fileURLToPath(new URL('../scripts/devspace-stable-gateway-whole-restart.mjs', import.meta.url));
    const result = JSON.parse(execFileSync(process.execPath, [entry, '--status', '--config-dir', root], { encoding: 'utf8', timeout: 5000 }));
    assert.equal(result.readOnly, true); assert.equal(result.record.state, 'verified-sentinel');
    assert.equal(await readFile(path, 'utf8'), text); assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
    assert.deepEqual(await readdir(join(root, 'logs')), ['stable-gateway-whole-restart-result.json']);
    const bad = spawnSync(process.execPath, [entry, '--stats', '--config-dir', root], { encoding: 'utf8', timeout: 5000 });
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /Unknown restart argument/);
    assert.equal(await readFile(path, 'utf8'), text);
  } finally { await rm(root, { recursive: true, force: true }); }
});
