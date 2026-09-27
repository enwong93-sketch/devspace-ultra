import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async path => await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [installer, setup, duckDns, readme, setupDoc, configDoc, gotchas, securityDoc, legacySetup] = await Promise.all([
  'install.ps1', 'scripts/devspace-public-setup.ps1', 'scripts/devspace-duckdns-update.ps1',
  'README.md', 'docs/ONE_COMMAND_SETUP.md', 'docs/configuration.md', 'docs/gotchas.md',
  'docs/security.md', 'docs/setup.md',
].map(read));

assert.match(installer, /releases\/tags\//, 'fresh Windows install must resolve an exact stable Release');
assert.match(installer, /devspace-ultra-[^\s"']+\.tgz/, 'fresh install must use the release archive, not a Git URL global junction');
assert.match(installer, /Get-FileHash[\s\S]*SHA256|SHA256[\s\S]*Get-FileHash/, 'release archive digest must be verified before install');
assert.doesNotMatch(installer, /npm install --global \$source\b/i, 'Windows must not globally install the Git URL');
assert.match(installer, /npm rebuild better-sqlite3|npm rebuild[^\r\n]*better-sqlite3/i, 'native SQLite must be rebuilt after ignored install scripts');
assert.match(installer, /better-sqlite3[\s\S]*:memory:/, 'native SQLite binding must be exercised before setup');
assert.doesNotMatch(installer, /DevSpace Ultra setup completed\./, 'local readiness must not be presented as public Connector completion');

assert.match(setup, /function Set-Property[\s\S]*?\.Match\(\$Name\)/, 'empty StrictMode config must support safe property checks');
assert.match(setup, /devspace-fixed-backend\.mjs[\s\S]*--config-dir|--config-dir[\s\S]*devspace-fixed-backend\.mjs/, 'Gateway task must load the same config directory setup writes');
assert.match(setup, /devspace-local-ingress\.ps1/, 'DuckDNS fast setup must use the maintained WAN/UPnP/Caddy ingress path');
assert.match(setup, /Export-ScheduledTask[\s\S]*-SelectedCaddyfilePath[\s\S]*Disable-ScheduledTask/, 'legacy ingress migration must back up tasks, reuse Caddy, and disable old tasks');
assert.match(setup, /EnableRouterUpnp[\s\S]*ManualPortForward/, 'router mappings require an explicit UPnP or manual choice');
assert.match(setup, /publicConnectorVerified\s*=\s*\$false/, 'local setup must explicitly report public Connector acceptance pending');
assert.doesNotMatch(duckDns, /&ip="/, 'legacy DuckDNS updater must never fall back to blank-IP auto-detection');

assert.doesNotMatch(readme, /irm[^\r\n]*\/main\/install\.ps1[^\r\n]*\|\s*iex/i, 'README must not offer direct execution of unpinned main');
assert.doesNotMatch(readme, /npm install -g github:[^\r\n]*#main/i, 'README must not offer an unsafe competing Windows install route');
for (const [name, source] of [
  ['docs/setup.md', legacySetup], ['docs/configuration.md', configDoc],
  ['docs/gotchas.md', gotchas], ['docs/security.md', securityDoc],
]) {
  assert.doesNotMatch(source, /npx @waishnav\/devspace|127\.0\.0\.1:7676/i, `${name} still advertises the old upstream install/port`);
}
assert.match(setupDoc, /publicly routable|publicly reachable|router forwarding/i);
console.log(JSON.stringify({ ok:true, gate:'windows-install-repair-static', publicConnectorAcceptanceRequired:true, oldInstallRoutesRemoved:true }));
