import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import semver from 'semver';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const packages = lock.packages || {};
const alias = '@devspace/pi-coding-agent';
const rootSpec = pkg.dependencies?.[alias];
assert.equal(rootSpec, 'npm:@earendil-works/pi-coding-agent@0.86.1',
  'security-reviewed pi dependency must stay exact and must not silently float');
assert.equal(pkg.dependencies?.['@earendil-works/pi-coding-agent'], undefined,
  'the shrinkwrapped vulnerable direct package must not remain alongside the reviewed alias');

function versionAt(suffix) {
  const entry = packages[`node_modules/${alias}/node_modules/${suffix}`];
  assert.ok(entry?.version, `missing locked ${suffix} below ${alias}`);
  return entry.version;
}
const pi = packages[`node_modules/${alias}`];
assert.equal(pi?.version, '0.86.1');
assert.equal(pi?.resolved, 'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.86.1.tgz');
const undici = versionAt('undici');
const protobufjs = versionAt('protobufjs');
const braceExpansion = versionAt('brace-expansion');
assert.ok(semver.gte(undici, '8.9.0'), `undici ${undici} is below the reviewed fix boundary`);
assert.ok(semver.gt(protobufjs, '7.6.4'), `protobufjs ${protobufjs} is still advisory-affected`);
assert.ok(semver.gte(braceExpansion, '5.0.9'), `brace-expansion ${braceExpansion} is still advisory-affected`);
assert.equal(pkg.version, '0.5.8', 'dependency remediation must not silently bump the DevSpace product version');

console.log(JSON.stringify({
  ok: true,
  gate: 'dependency-security-static',
  productVersion: pkg.version,
  piCodingAgent: pi.version,
  undici,
  protobufjs,
  braceExpansion,
  lifecycleScriptsExecutedByGate: false,
  networkUsedByGate: false,
}));
