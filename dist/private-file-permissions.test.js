import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPrivateWindowsAclText, hardenPrivateFile, privateWindowsAclArguments } from './private-file-permissions.js';

test('Windows private ACL removes inheritance and grants only owner/system/admin', () => {
  const calls = [];
  const result = hardenPrivateFile('C:\\private\\auth.json', {
    platform: 'win32',
    env: { USERDOMAIN: 'HOST', USERNAME: 'owner' },
    chmod: (path, mode) => calls.push(['chmod', path, mode]),
    execFile: (command, args, options) => calls.push(['exec', command, args, options]),
  });
  assert.equal(result.windowsAclHardened, true);
  assert.deepEqual(calls[0], ['chmod', 'C:\\private\\auth.json', 0o600]);
  assert.equal(calls[1][1], 'icacls.exe');
  assert.deepEqual(calls[1][2], [
    'C:\\private\\auth.json', '/inheritance:r', '/grant:r',
    'HOST\\owner:(F)', '*S-1-5-18:(F)', '*S-1-5-32-544:(F)',
  ]);
  assert.equal(JSON.stringify(calls).includes('CodexSandboxUsers'), false);
});

test('POSIX path receives mode 0600 without a subprocess', () => {
  const calls = [];
  hardenPrivateFile('/home/u/auth.json', {
    platform: 'linux',
    chmod: (...args) => calls.push(args),
    execFile: () => { throw new Error('must not execute'); },
  });
  assert.deepEqual(calls, [['/home/u/auth.json', 0o600]]);
});

test('untrusted Windows account text fails closed', () => {
  assert.throws(() => privateWindowsAclArguments('x', { USERDOMAIN: 'HOST', USERNAME: 'bad\nuser' }), /Cannot resolve/);
});

test('ACL audit rejects inherited or sandbox-readable auth files', () => {
  assert.deepEqual(auditPrivateWindowsAclText('auth.json HOST\\owner:(F) NT AUTHORITY\\SYSTEM:(F)'), {
    inheritanceRemoved: true, broadSandboxReadPresent: false, private: true,
  });
  assert.equal(auditPrivateWindowsAclText('auth.json HOST\\CodexSandboxUsers:(I)(RX)').private, false);
});
