#!/usr/bin/env node
// Resume-safe full verification: bounded chat output, durable job id and logs.
// This runner never reloads production or retries the child command.
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const directory = join(tmpdir(), 'devspace-stability-audits');
mkdirSync(directory, { recursive: true });
const [mode = 'run', requestedId] = process.argv.slice(2);
if (mode === 'status') {
  if (!requestedId || !/^[a-f0-9-]{36}$/.test(requestedId)) throw new Error('status requires the returned audit id');
  console.log(readFileSync(join(directory, requestedId + '.json'), 'utf8'));
} else if (mode === 'run' && !requestedId) {
  const id = randomUUID();
  const statusPath = join(directory, id + '.json');
  const logPath = join(directory, id + '.log');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const state = {
    id, command: 'npm run verify:ultra', status: 'starting',
    revision: git('rev-parse', 'HEAD').trim(),
    trackedDiffSha256: createHash('sha256').update(git('diff', 'HEAD', '--no-ext-diff')).digest('hex'),
    startedAt: new Date().toISOString(), updatedAt: null, completedAt: null,
    exitCode: null, childPid: null, passedGateCount: 0, lastPassedGate: null,
    statusPath, logPath, productionReloaded: false,
  };
  const save = () => {
    state.updatedAt = new Date().toISOString();
    writeFileSync(statusPath + '.tmp', JSON.stringify(state, null, 2));
    renameSync(statusPath + '.tmp', statusPath);
  };
  save();
  console.log(JSON.stringify({ id, statusPath, logPath, status: 'starting' }));
  const log = createWriteStream(logPath, { flags: 'wx' });
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run verify:ultra'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('npm', ['run', 'verify:ultra'], { stdio: ['ignore', 'pipe', 'pipe'] });
  state.childPid = child.pid || null;
  state.status = 'running';
  save();
  let retainedBytes = 0;
  const limit = 16 * 1024 * 1024;
  const gates = new Set();
  const buffers = { out: '', err: '' };
  function capture(stream, data) {
    if (retainedBytes < limit) { const part = data.subarray(0, limit - retainedBytes); log.write(part); retainedBytes += part.length; }
    buffers[stream] += data.toString('utf8');
    const lines = buffers[stream].split(/\r?\n/);
    buffers[stream] = lines.pop().slice(-65_536);
    let changed = false;
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.ok === true && typeof row.gate === 'string' && !gates.has(row.gate)) {
          gates.add(row.gate); state.lastPassedGate = row.gate; changed = true;
        }
      } catch { /* non-JSON compiler/test output stays only in the log */ }
    }
    if (changed) { state.passedGateCount = gates.size; save(); }
  }
  child.stdout.on('data', data => capture('out', data));
  child.stderr.on('data', data => capture('err', data));
  child.on('error', error => { state.launchError = error.code || error.name; });
  child.on('close', (code, signal) => {
    state.status = code === 0 && !signal && !state.launchError ? 'passed' : 'failed';
    state.exitCode = code; state.signal = signal; state.completedAt = new Date().toISOString();
    state.logBytes = retainedBytes; state.passedGates = [...gates];
    save(); log.end(); console.log(JSON.stringify(state)); process.exitCode = state.status === 'passed' ? 0 : 1;
  });
} else { throw new Error('Usage: devspace-stability-run.mjs [run | status <audit-id>]'); }
