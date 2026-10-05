import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const publishedLock = JSON.parse(await readFile(new URL('../npm-shrinkwrap.json', import.meta.url), 'utf8'));
assert.deepEqual(publishedLock, lock, 'published CLI dependency graph must match the reviewed CI lock');
const packages = lock.packages || {};
const alias = '@devspace/pi-coding-agent';
const rootSpec = pkg.dependencies?.[alias];
assert.equal(rootSpec, 'https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra/7d39a19173d3044adf656a0c6e93b91224f1ff73/vendor/pi-coding-agent-0.86.1-devspace.1.tgz',
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
assert.equal(pi?.resolved, rootSpec);
const provenance = JSON.parse(await readFile(new URL('../vendor/pi-security-provenance.json', import.meta.url), 'utf8'));
const archiveUrl = new URL('../vendor/pi-coding-agent-0.86.1-devspace.1.tgz', import.meta.url);
const archive = await readFile(archiveUrl);
assert.equal(provenance.upstream.version, '0.86.1');
assert.equal(provenance.upstream.archiveIntegrity,
  'sha512-vZBuNfJnruxZyemZ3O05V0S/Ylze08ahFTIQ1Mik++gVdOevPl89gt/Uv0U97BPAJaj9cj6Vf9rcIgKtUrd0BA==');
assert.equal(provenance.changedPackage, 'node_modules/brace-expansion');
assert.equal(provenance.toVersion, '5.0.12');
assert.equal(createHash('sha256').update(archive).digest('hex'), provenance.patchedArchiveSha256);
const archiveIntegrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
assert.equal(archiveIntegrity, provenance.patchedArchiveIntegrity);
assert.equal(pi?.integrity, archiveIntegrity, 'lock must bind the exact reviewed vendor archive');
const shrinkwrapText = execFileSync('tar', ['-xOf', fileURLToPath(archiveUrl), 'package/npm-shrinkwrap.json'],
  { encoding:'utf8', maxBuffer:2*1024*1024 });
assert.equal(createHash('sha256').update(shrinkwrapText).digest('hex'), provenance.patchedShrinkwrapSha256);
const shrinkwrap = JSON.parse(shrinkwrapText);
assert.equal(shrinkwrap.packages['node_modules/brace-expansion'].version, '5.0.12');
assert.equal(shrinkwrap.packages['node_modules/brace-expansion'].integrity, provenance.patchIntegrity);
assert.ok(pkg.files.includes('vendor'), 'fresh Release archives must carry the reviewed dependency');
assert.ok(pkg.files.includes('npm-shrinkwrap.json'), 'published CLI dependency lock must be explicitly packed');
const undici = versionAt('undici');
const protobufjs = versionAt('protobufjs');
const braceExpansion = versionAt('brace-expansion');
assert.ok(semver.gte(undici, '8.9.0'), `undici ${undici} is below the reviewed fix boundary`);
assert.ok(semver.gt(protobufjs, '7.6.4'), `protobufjs ${protobufjs} is still advisory-affected`);
assert.ok(semver.gte(braceExpansion, '5.0.12'), `brace-expansion ${braceExpansion} is still advisory-affected`);
const fastUri = packages['node_modules/fast-uri']?.version;
const ipAddress = packages['node_modules/ip-address']?.version;
assert.ok(fastUri && semver.gte(fastUri, '3.1.8'), `fast-uri ${fastUri} is still advisory-affected`);
assert.ok(ipAddress && semver.gte(ipAddress, '10.7.1'), `ip-address ${ipAddress} is still advisory-affected`);
assert.equal(pkg.version, '0.5.24', 'reviewed ChatGPT Classic install-contract release version must not silently drift');

console.log(JSON.stringify({
  ok: true,
  gate: 'dependency-security-static',
  productVersion: pkg.version,
  piCodingAgent: pi.version,
  undici,
  protobufjs,
  braceExpansion,
  fastUri,
  ipAddress,
  reviewedVendorArchive: provenance.patchedArchiveSha256,
  publishedDependencyGraphPinned: true,
  lifecycleScriptsExecutedByGate: false,
  networkUsedByGate: false,
}));
