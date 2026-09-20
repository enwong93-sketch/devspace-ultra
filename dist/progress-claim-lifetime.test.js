import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const html=await readFile(new URL('./ui/progress-claim-relay.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const now=Date.now();
const claim={claimId:'claim_lifetime_test_20260920',expiresAt:new Date(now+90_000).toISOString(),state:'pending'};
function harness(callTool){
  const timers=[];let closes=0;
  const window={addEventListener(){},parent:{},openai:{toolOutput:{structuredContent:{progressClaim:claim}},
    callTool,requestClose:async()=>{closes++;}}};
  runInNewContext(script,{window,Date,setTimeout:(callback,ms)=>{timers.push({callback,ms});return timers.length;}});
  return {timers,closes:()=>closes};
}
test('a completed receipt remains available for exact next-tool bootstrap until its declared expiry',async()=>{
  const h=harness(async()=>({structuredContent:{ok:true,claimed:true}}));
  await Promise.resolve();await Promise.resolve();
  assert.equal(h.closes(),0,'closing the receipt immediately invalidates the next Goal/Plan authority check');
  const expiry=h.timers.find(t=>t.ms>80_000&&t.ms<=90_000);assert.ok(expiry);
  await expiry.callback();assert.equal(h.closes(),1);
});
test('a hung host call cannot prevent bounded expiry cleanup',async()=>{
  const h=harness(()=>new Promise(()=>{}));
  const expiry=h.timers.find(t=>t.ms>80_000&&t.ms<=90_000);assert.ok(expiry);
  await expiry.callback();assert.equal(h.closes(),1);
});
