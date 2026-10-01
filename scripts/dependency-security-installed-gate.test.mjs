import assert from 'node:assert/strict';
import test from 'node:test';
import { validateInstalledDependencyVersions } from './dependency-security-installed-gate.mjs';
const good={piCodingAgent:'0.86.1',undici:'8.10.2',protobufjs:'7.6.6',braceExpansion:'5.0.12',fastUri:'3.1.8',ipAddress:'10.7.2'};
test('all reviewed installed dependencies pass',()=>assert.equal(validateInstalledDependencyVersions(good).ok,true));
for(const [name,affected] of Object.entries({piCodingAgent:'1.0.0',undici:'8.8.0',protobufjs:'7.6.4',braceExpansion:'5.0.9',fastUri:'3.1.7',ipAddress:'10.7.0'}))
  test(`an affected or unreviewed installed ${name} fails closed`,()=>assert.throws(()=>validateInstalledDependencyVersions({...good,[name]:affected})));
test('a missing installed package version is not inferred from the root lock',()=>assert.throws(()=>validateInstalledDependencyVersions({...good,braceExpansion:undefined})));
