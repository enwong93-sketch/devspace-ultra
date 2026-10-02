import assert from 'node:assert/strict';
import test from 'node:test';

let instance = 0;
async function freshInspector() {
  return import(`./goal-host-bridge.js?observation-boundary-test=${++instance}`);
}
function fixture(modes = []) {
  const nativeAdmissions = [];
  let evaluations = 0;
  class Socket {
    constructor() { this.listeners = new Map(); queueMicrotask(() => this.emit('open', {})); }
    addEventListener(type, fn, options = {}) {
      this.listeners.set(type, [...(this.listeners.get(type) || []), {fn, once:options.once}]);
    }
    removeEventListener(type, fn) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(x => x.fn !== fn));
    }
    emit(type, event) {
      for (const entry of [...(this.listeners.get(type) || [])]) {
        entry.fn(event); if(entry.once) this.removeEventListener(type, entry.fn);
      }
    }
    close() { this.emit('close', {}); }
    send(raw) {
      const request = JSON.parse(raw);
      const answer = result => queueMicrotask(() => this.emit('message', {data:JSON.stringify({id:request.id,result})}));
      if (request.method === 'Runtime.enable') {
        if (modes[0] === 'enable-error') {
          modes.shift(); queueMicrotask(() => this.emit('message', {data:JSON.stringify({id:request.id,error:{message:'enable failed'}})}));
        } else answer({});
        return;
      }
      assert.equal(request.method, 'Runtime.evaluate');
      const enabled = request.params.expression.match(/if \(conversationId && (true|false)\) \{/);
      assert.ok(enabled, 'the native request admission boundary must be explicit');
      nativeAdmissions.push(enabled[1] === 'true');
      const mode = modes[evaluations++];
      if (mode === 'timeout') return;
      if (mode === 'disconnect') { queueMicrotask(() => this.emit('close', {})); return; }
      const state = request.params.expression.includes('native-branch-observation-unconfirmed-backoff')
        ? 'native-branch-observation-unconfirmed-backoff' : 'native-branch-rate-limit-backoff';
      const nativeContinuation = mode === '429'
        ? {resolved:false,state:'conversation-fetch-429',retryAfter:'120'}
        : enabled[1] === 'true' ? {resolved:true} : {resolved:false,state};
      answer({result:{value:{conversationId:'owned-conversation',chatMode:true,nativeContinuation}}});
    }
  }
  return { nativeAdmissions, options:{WebSocketImpl:Socket,timeoutMs:250,includeNativeBranch:true},
    candidate:{pageWebSocketDebuggerUrl:'ws://fixture-only',pageTargetId:'owned-page'} };
}

for (const mode of ['timeout','disconnect']) {
  test(`an unconfirmed native observation ${mode} does not admit an immediate second request`, async t => {
    const {inspectVisibleReportCommit} = await freshInspector();
    const f=fixture([mode]); let now=Date.now(); t.mock.method(Date,'now',()=>now);
    const keepAlive=setInterval(()=>{},1000); t.after(()=>clearInterval(keepAlive));
    await assert.rejects(inspectVisibleReportCommit(f.candidate,f.options), /timed out|closed/i);
    const retry=await inspectVisibleReportCommit(f.candidate,f.options);
    assert.deepEqual(f.nativeAdmissions,[true,false]);
    assert.equal(retry.nativeContinuation.resolved,false);
    assert.equal(retry.nativeContinuation.state,'native-branch-observation-unconfirmed-backoff');
    now+=60_001;
    await inspectVisibleReportCommit(f.candidate,f.options);
    assert.deepEqual(f.nativeAdmissions,[true,false,true], 'only the bounded quiet period expires, not a Goal round');
  });
}

test('a failed setup before native admission does not suppress another exact read', async t => {
  const {inspectVisibleReportCommit}=await freshInspector(); const f=fixture(['enable-error']);
  await assert.rejects(inspectVisibleReportCommit(f.candidate,f.options), /enable failed/);
  await inspectVisibleReportCommit(f.candidate,f.options);
  assert.deepEqual(f.nativeAdmissions,[true]);
});

test('a completed native observation does not add an artificial quiet period', async () => {
  const {inspectVisibleReportCommit}=await freshInspector(); const f=fixture();
  await inspectVisibleReportCommit(f.candidate,f.options);
  await inspectVisibleReportCommit(f.candidate,f.options);
  assert.deepEqual(f.nativeAdmissions,[true,true]);
});

test('a failed blocked metadata observation never shortens provider Retry-After', async t => {
  const {inspectVisibleReportCommit}=await freshInspector(); const f=fixture(['429','disconnect']);
  let now=Date.now(); t.mock.method(Date,'now',()=>now);
  await inspectVisibleReportCommit(f.candidate,f.options);
  await assert.rejects(inspectVisibleReportCommit(f.candidate,f.options), /closed/);
  now+=60_001; await inspectVisibleReportCommit(f.candidate,f.options);
  assert.deepEqual(f.nativeAdmissions,[true,false,false]);
  now+=60_001; await inspectVisibleReportCommit(f.candidate,f.options);
  assert.deepEqual(f.nativeAdmissions,[true,false,false,true]);
});
