import assert from 'node:assert/strict';
import {observeNativeMaintenance} from './native-maintenance-observer.js';
const cid='fixture-observer-conversation',aid='fixture-observer-assistant',uid='fixture-observer-user',page='fixture-observer-page';
const payload={id:cid,current_node:aid,mapping:{[uid]:{message:{id:uid,author:{role:'user'},create_time:1,content:{content_type:'text',parts:['fixture user']}}},
 [aid]:{parent:uid,message:{id:aid,author:{role:'assistant'},status:'finished_successfully',end_turn:true,create_time:2,
 content:{content_type:'text',parts:['fixture final']}}}}};
const scope={conversationId:cid,pageTargetId:page,runtimeKey:'main-01',port:9721,pageWebSocketDebuggerUrl:'ws://fixture'};
const run=async mode=>{
 const handlers=new Map();let clock=10000,calls=[];
 const emit=(m,p)=>handlers.get(m)?.(p);
 const client={open:async()=>{},close(){},on(m,h){handlers.set(m,h)},async call(m,p){
  calls.push(m);
  if(m==='Network.getResponseBody'){
   if(mode==='in-progress')return{body:JSON.stringify({...payload,current_node:uid})};
   return{body:JSON.stringify(payload)};
  }
  if(m==='Network.enable')queueMicrotask(()=>{
   if(mode==='post'){emit('Network.requestWillBeSent',{request:{method:'POST',url:'https://chatgpt.com/backend-api/f/conversation'}});return;}
   if(mode==='navigation'){emit('Page.navigatedWithinDocument',{frameId:page});return;}
   const event=i=>{
    const requestId='fixture-request-'+i;
    emit('Network.requestWillBeSent',{requestId,frameId:page,wallTime:clock/1000,
     request:{method:'GET',url:'https://chatgpt.com/backend-api/conversation/'+cid}});
    emit('Network.responseReceived',{requestId,response:{status:mode==='429'?429:200,fromDiskCache:mode==='cached'}});
    clock++;
    emit('Network.loadingFinished',{requestId});
   };
   event(1);setTimeout(()=>{clock+=100;event(2)},5);
  });return{};
 }};
 const r=await observeNativeMaintenance(scope,{clientFactory:()=>client,now:()=>clock,timeoutMs:1000});
 assert.ok(calls.every(m=>['Page.enable','Network.enable','Network.getResponseBody'].includes(m)));
 return r;
};
assert.equal((await run('valid')).ready,true);
assert.equal((await run('in-progress')).ready,false);
assert.equal((await run('post')).reason,'new-native-request-during-maintenance');
assert.equal((await run('navigation')).ready,false);
assert.equal((await run('cached')).ready,false);
assert.equal((await run('429')).ready,false);
console.log(JSON.stringify({ok:true,gate:'passive-native-maintenance',extraNativeFetches:0,nativeFinalRequired:true,newRequestVeto:true}));
