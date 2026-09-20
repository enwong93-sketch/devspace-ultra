import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { attachHttpRuntimeLifecycle } from './http-runtime-lifecycle.js';

test('listener closure stops background runtime exactly once', async () => {
  const http = new EventEmitter();
  let calls = 0;
  const lifecycle = attachHttpRuntimeLifecycle(http, async () => { calls += 1; });
  assert.equal(calls, 0);
  http.emit('close');
  await lifecycle.close();
  await lifecycle.close();
  assert.equal(calls, 1);
});

test('failed listener startup cannot leave Core observers running', async () => {
  const http = new EventEmitter();
  let calls = 0;
  const errors = [];
  const lifecycle = attachHttpRuntimeLifecycle(http, async () => { calls += 1; }, { onError: e => errors.push(e.code) });
  http.emit('error', Object.assign(new Error('listener occupied'), { code: 'EADDRINUSE' }));
  http.emit('close');
  await lifecycle.close();
  assert.equal(calls, 1);
  assert.deepEqual(errors, ['EADDRINUSE']);
});

test('cleanup failure is observed rather than becoming an unhandled rejection', async () => {
  const http = new EventEmitter();
  const errors = [];
  const lifecycle = attachHttpRuntimeLifecycle(http, async () => { throw new Error('cleanup failed'); }, { onError: e => errors.push(e.message) });
  http.emit('close');
  await lifecycle.close();
  assert.deepEqual(errors, ['cleanup failed']);
});

test('real HTTP listener close triggers the same single cleanup path', async () => {
  const http = createServer((_req, res) => res.end('ok'));
  let calls = 0;
  const lifecycle = attachHttpRuntimeLifecycle(http, async () => { calls += 1; });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  await lifecycle.close();
  assert.equal(calls, 1);
});
