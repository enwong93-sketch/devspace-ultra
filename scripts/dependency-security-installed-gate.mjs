import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';

export function validateInstalledDependencyVersions(versions) {
  assert.equal(versions.piCodingAgent, '0.86.1', 'reviewed Pi implementation must not drift');
  for (const [name, minimum] of Object.entries({undici:'8.9.0',protobufjs:'7.6.5',braceExpansion:'5.0.12',fastUri:'3.1.8',ipAddress:'10.7.1'})) {
    assert.ok(semver.valid(versions[name]) && semver.gte(versions[name], minimum),
      `installed ${name} ${versions[name]} is below the reviewed fix boundary ${minimum}`);
  }
  return {ok:true,gate:'dependency-security-installed',...versions,metadataOnly:true};
}

async function resolvedPackage(name, from) {
  let directory = dirname(createRequire(from).resolve(name));
  for (;;) {
    try {
      const filename=resolve(directory,'package.json');
      const pkg=JSON.parse(await readFile(filename,'utf8'));
      if(pkg.name === name || (name==='@devspace/pi-coding-agent' && pkg.name==='@earendil-works/pi-coding-agent')) return {pkg,filename};
    } catch {}
    const parent=dirname(directory);
    if(parent===directory) throw new Error(`Cannot verify installed package metadata for ${name}`);
    directory=parent;
  }
}

export async function main() {
  const rootManifest=fileURLToPath(new URL('../package.json',import.meta.url));
  // Pi exposes only an ESM import entry, so require.resolve(alias) is not an
  // authority for its package root. Verify the installed exact alias directory.
  const piFilename=resolve(dirname(rootManifest),'node_modules/@devspace/pi-coding-agent/package.json');
  const pi={pkg:JSON.parse(await readFile(piFilename,'utf8')),filename:piFilename};
  assert.equal(pi.pkg.name,'@earendil-works/pi-coding-agent');
  const versions={piCodingAgent:pi.pkg.version};
  for(const [name,key] of [['undici','undici'],['protobufjs','protobufjs'],['brace-expansion','braceExpansion']])
    versions[key]=(await resolvedPackage(name,pi.filename)).pkg.version;
  for(const [name,key] of [['fast-uri','fastUri'],['ip-address','ipAddress']])
    versions[key]=(await resolvedPackage(name,rootManifest)).pkg.version;
  const result=validateInstalledDependencyVersions(versions);
  console.log(JSON.stringify(result));
  return result;
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  main().catch(error=>{console.error(`Installed dependency verification refused: ${error.message}`);process.exitCode=1;});
