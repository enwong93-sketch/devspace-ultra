import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from './server.js';
import {loadConfig} from './config.js';
const root=await mkdtemp(join(tmpdir(),'devspace-session-http-'));
const owner='0123456789abcdef0123456789abcdef';
const config=loadConfig({DEVSPACE_TOOL_MODE:'compact',DEVSPACE_WIDGETS:'off',DEVSPACE_CONFIG_DIR:join(root,'config'),DEVSPACE_OAUTH_OWNER_TOKEN:owner,DEVSPACE_ALLOWED_ROOTS:root,DEVSPACE_STATE_DIR:join(root,'state'),DEVSPACE_PLUGINS_DIR:join(root,'plugins'),DEVSPACE_CAPABILITY_REGISTRY:join(root,'plugins/registry.json'),DEVSPACE_AGENT_DIR:join(root,'agents'),DEVSPACE_PUBLIC_BASE_URL:'http://127.0.0.1:1',DEVSPACE_PLUGINS:'false',DEVSPACE_AUTO_COMPACT:'false',DEVSPACE_SUBAGENTS:'false',DEVSPACE_LOG_REQUESTS:'false',DEVSPACE_LOG_TOOL_CALLS:'false',DEVSPACE_LOG_LEVEL:'error'});
const app=createServer(config,{maxMcpSessions:2,codexContextBridge:null});
const http=await new Promise(resolve=>{const server=app.app.listen(0,'127.0.0.1',()=>resolve(server));});
const base='http://127.0.0.1:'+http.address().port,resource='http://127.0.0.1:1/mcp';
const aborts=[];
try {
 const redirect='http://127.0.0.1/cb',verifier='rehearsal-verifier-0123456789abcdefghijklmnopqrstuvwxyz';
 const r=await fetch(base+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']})});assert.equal(r.status,201);const registered=await r.json();
 const a=await fetch(base+'/authorize',{method:'POST',redirect:'manual',body:new URLSearchParams({client_id:registered.client_id,redirect_uri:redirect,response_type:'code',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:'devspace',resource,owner_token:owner})});assert.equal(a.status,302);
 const tr=await fetch(base+'/token',{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',client_id:registered.client_id,redirect_uri:redirect,code_verifier:verifier,code:new URL(a.headers.get('location')).searchParams.get('code'),resource})});assert.equal(tr.status,200);const token=(await tr.json()).access_token;
 let id=0;
 const headers={Authorization:'Bearer '+token,Accept:'application/json, text/event-stream','Content-Type':'application/json','mcp-protocol-version':'2025-03-26'};
 const request=(method,params,session)=>fetch(base+'/mcp',{method:'POST',headers:{...headers,...(session?{'mcp-session-id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
 const init=()=>request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
 async function create(){const r=await init();assert.equal(r.status,200);await r.text();return r.headers.get('mcp-session-id');}
 const first=await create(),second=await create();
 async function rpc(method, params) {
  const response=await request(method,params,first);
  assert.equal(response.status,200);
  const body=await response.text();
  const message=JSON.parse(body.startsWith('event:') ? body.split('\n').find(line=>line.startsWith('data: ')).slice(6) : body);
  assert.equal(message.error,undefined);
  assert.notEqual(message.result.isError,true);
  return message.result;
 }
 const catalog=await rpc('tools/list',{});
 const names=catalog.tools.map(tool=>tool.name);
 for(const name of ['open_workspace','workspace_task']) assert.ok(names.includes(name),name);
 for(const name of ['read','apply_patch','exec_command','write_stdin','write','edit','bash']) assert.ok(!names.includes(name),name);
 const workspace=await rpc('tools/call',{name:'open_workspace',arguments:{path:root}});
 const batch=await rpc('tools/call',{name:'workspace_task',arguments:{workspaceId:workspace.structuredContent.workspaceId,operations:[
  {type:'exec',cmd:'node --version',yieldTimeMs:10000},
  {type:'exec',cmd:'git --version',yieldTimeMs:10000}
 ]}});
 assert.equal(batch.structuredContent.ok,true);
 assert.equal(batch.structuredContent.completed,2);
 assert.equal(batch.structuredContent.operations.length,2);
 for(const operation of batch.structuredContent.operations) assert.equal(operation.exitCode,0);
 for(const session of [first,second]){const controller=new AbortController();aborts.push(controller);const stream=await fetch(base+'/mcp',{headers:{...headers,'mcp-session-id':session},signal:controller.signal});assert.equal(stream.status,200);}
 const full=await init();assert.equal(full.status,503);assert.equal(full.headers.get('retry-after'),'1');await full.text();
 const ping=await request('ping',{},first);assert.equal(ping.status,200);await ping.text();
 aborts[1].abort();
 await new Promise(r=>setTimeout(r,30));
 const third=await create();
 const stale=await request('ping',{},second);assert.equal(stale.status,404);await stale.text();
 const stillLive=await request('ping',{},first);assert.equal(stillLive.status,200);await stillLive.text();
 const deleted=await fetch(base+'/mcp',{method:'DELETE',headers:{...headers,'mcp-session-id':third}});assert.equal(deleted.status,200);await deleted.text();
 const afterDelete=await request('ping',{},third);assert.equal(afterDelete.status,404);await afterDelete.text();
 console.log(JSON.stringify({ok:true,gate:'compact-mcp-http',workspaceTools:['open_workspace','workspace_task'],batchOperations:2,activeSseProtected:true,capacity503:true,idleEviction404:true,explicitDelete:true}));
} finally {
 for(const a of aborts)a.abort();
 await app.close();
 await new Promise(resolve=>http.close(resolve));
 await rm(root,{recursive:true,force:true});
}
