#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { devspaceAuthPath } from '../dist/user-config.js';
import { auditPrivateWindowsAclText, hardenPrivateFile } from '../dist/private-file-permissions.js';

const path = devspaceAuthPath();
if (!existsSync(path)) throw new Error('DevSpace auth file does not exist.');
const result = hardenPrivateFile(path);
let aclAudit = { private: true, inheritanceRemoved: true, broadSandboxReadPresent: false };
if (process.platform === 'win32') {
  const text = execFileSync('icacls.exe', [path], { encoding: 'utf8', windowsHide: true });
  aclAudit = auditPrivateWindowsAclText(text);
  if (!aclAudit.private) throw new Error('DevSpace auth ACL remained inherited or broadly readable after hardening.');
}
console.log(JSON.stringify({ ok: true, gate: 'private-auth-permissions', ...result, ...aclAudit, rawAuthRead: false, rawAclReturned: false }));
