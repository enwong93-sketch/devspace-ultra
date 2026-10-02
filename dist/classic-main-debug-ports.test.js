import assert from 'node:assert/strict';
import {
  classicMainDebugPorts,
  normalizeClassicMainProcessRows,
  observedClassicMainPortEntries,
  runtimeKeyForClassicPort,
  runtimePortsForClassicKey,
} from './classic-main-debug-ports.js';

const rows = [
  { port: 9732, mainNumber: 2, commandLine: 'chatgpt-classic-main02.exe --remote-debugging-port=9732' },
  { port: 19735, mainNumber: 5, commandLine: 'chatgpt-classic-main05.exe --remote-debugging-port=19735' },
  { port: 19735, commandLine: 'child --remote-debugging-port=19735' },
  { port: 99999, mainNumber: 6 },
];
const normalized = normalizeClassicMainProcessRows(rows);
assert.deepEqual(normalized.map(row => [row.runtimeKey, row.port]), [['main-02', 9732], ['main-05', 19735]]);
observedClassicMainPortEntries({ rows });
assert.deepEqual(runtimePortsForClassicKey('main-05'), [19735, 9735]);
assert.equal(runtimeKeyForClassicPort(19735), 'main-05');
assert.equal(runtimeKeyForClassicPort(9734), 'main-04');
assert.equal(runtimeKeyForClassicPort(25000), 'main@25000');
assert.equal(classicMainDebugPorts().length, 32, 'public static catalog remains deterministic');
const withObserved = classicMainDebugPorts({ includeObserved: true });
assert.equal(withObserved.includes(19735), true);
assert.equal(withObserved.includes(9735), true, 'fallback port remains available after a runtime restarts normally');
const previousDiscovery = process.env.DEVSPACE_DISABLE_CLASSIC_PORT_DISCOVERY;
try {
  process.env.DEVSPACE_DISABLE_CLASSIC_PORT_DISCOVERY = 'true';
  observedClassicMainPortEntries({ rows: [] });
  assert.equal(runtimePortsForClassicKey('main-05').includes(19735), true,
    'a failed process inventory must not remove the known legacy Main fallback');
  const unavailableInventory = classicMainDebugPorts({ includeObserved: true, refresh: true });
  assert.equal(unavailableInventory.includes(19735), true,
    'startup inventory unavailability cannot permanently hide an existing legacy Main');
  assert.equal(unavailableInventory.includes(9735), true);
  assert.equal(classicMainDebugPorts().length, 32, 'static public catalog is unchanged');
  assert.deepEqual(runtimePortsForClassicKey('main-01'), [9721]);
  assert.deepEqual(runtimePortsForClassicKey('main-99'), []);
} finally {
  if (previousDiscovery === undefined) delete process.env.DEVSPACE_DISABLE_CLASSIC_PORT_DISCOVERY;
  else process.env.DEVSPACE_DISABLE_CLASSIC_PORT_DISCOVERY = previousDiscovery;
  observedClassicMainPortEntries({ rows });
}
console.log(JSON.stringify({ ok: true, gate: 'classic-main-debug-ports', observedPortAuthority: true, fallbackPreserved: true }));
