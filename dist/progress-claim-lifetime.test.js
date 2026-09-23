import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const html=await readFile(new URL('./ui/progress-claim-relay.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const now=Date.now();
const claim={claimId:'claim_lifetime_test_20260920',expiresAt:new Date(now+90_000).toISOString(),state:'pending'};
function harness(callTool){
  const timers=[];const listeners=new Map();const removed=[];let hostCloseRequests=0;
  const window={
    addEventListener(name,handler){listeners.set(name,handler);},
    removeEventListener(name,handler){if(listeners.get(name)===handler){listeners.delete(name);removed.push(name);}},
    parent:{},
    openai:{
      toolOutput:{structuredContent:{progressClaim:claim}},
      callTool,
      requestClose:async()=>{hostCloseRequests++;},
    },
  };
  runInNewContext(script,{window,Date,setTimeout:(callback,ms)=>{timers.push({callback,ms});return timers.length;}});
  return {timers,listeners,removed,hostCloseRequests:()=>hostCloseRequests};
}
test('a completed receipt remains available until expiry without closing ChatGPT host UI',async()=>{
  const h=harness(async()=>({structuredContent:{ok:true,claimed:true}}));
  await Promise.resolve();await Promise.resolve();
  assert.equal(h.hostCloseRequests(),0,'the hidden relay must never request host UI closure');
  assert.equal(h.listeners.size,2,'the exact-page receipt remains available during its bounded lifetime');
  const expiry=h.timers.find(t=>t.ms>80_000&&t.ms<=90_000);assert.ok(expiry);
  await expiry.callback();
  assert.equal(h.hostCloseRequests(),0,'expiry performs local retirement only');
  assert.deepEqual([...h.removed].sort(),['message','openai:set_globals']);
  assert.equal(h.listeners.size,0);
});
test('a hung host call cannot prevent bounded local relay retirement',async()=>{
  const h=harness(()=>new Promise(()=>{}));
  const expiry=h.timers.find(t=>t.ms>80_000&&t.ms<=90_000);assert.ok(expiry);
  await expiry.callback();
  assert.equal(h.hostCloseRequests(),0);
  assert.deepEqual([...h.removed].sort(),['message','openai:set_globals']);
  assert.equal(h.listeners.size,0);
});
