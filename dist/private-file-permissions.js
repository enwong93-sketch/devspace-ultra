import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';

const SYSTEM_SID = '*S-1-5-18';
const ADMINISTRATORS_SID = '*S-1-5-32-544';

function windowsUser(env = process.env) {
  const domain = String(env.USERDOMAIN || '').trim();
  const name = String(env.USERNAME || env.USER || '').trim();
  if (!name || /[\r\n"*?]/.test(name) || /[\r\n"*?]/.test(domain)) return null;
  return domain ? `${domain}\\${name}` : name;
}

export function privateWindowsAclArguments(filePath, env = process.env) {
  const user = windowsUser(env);
  if (!user) throw new Error('Cannot resolve the current Windows account for private-file ACL hardening.');
  return [
    filePath,
    '/inheritance:r',
    '/grant:r',
    `${user}:(F)`,
    `${SYSTEM_SID}:(F)`,
    `${ADMINISTRATORS_SID}:(F)`,
  ];
}

export function hardenPrivateFile(filePath, {
  platform = process.platform,
  env = process.env,
  chmod = chmodSync,
  execFile = execFileSync,
} = {}) {
  chmod(filePath, 0o600);
  if (platform === 'win32') {
    execFile('icacls.exe', privateWindowsAclArguments(filePath, env), {
      windowsHide: true,
      stdio: 'ignore',
    });
  }
  return { filePath, mode: '0600', windowsAclHardened: platform === 'win32' };
}

export function auditPrivateWindowsAclText(text) {
  const value = String(text || '');
  const inheritedAcePresent = /\(I\)/i.test(value);
  const broadSandboxReadPresent = /CodexSandboxUsers|Authenticated Users|Everyone|BUILTIN\\Users/i.test(value);
  return {
    inheritanceRemoved: !inheritedAcePresent,
    broadSandboxReadPresent,
    private: !inheritedAcePresent && !broadSandboxReadPresent,
  };
}

export const privateFilePermissionInternals = { windowsUser, SYSTEM_SID, ADMINISTRATORS_SID };
