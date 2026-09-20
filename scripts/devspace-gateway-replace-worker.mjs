#!/usr/bin/env node
// Only the locally generated canonical replacement plan is accepted.
// The shared Windows Job and all application processes remain untouched.
import {spawn, execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {atomicWriteJson} from '../dist/atomic-file.js';
import {queryListenerProcesses} from '../dist/stable-gateway-restart.js';

const run=promisify(execFile);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const planPath=resolve(process.argv[2] || '');
if (!planPath.endsWith('stable-gateway-replacement-plan.json')) throw new Error('Canonical replacement plan required');
const plan=JSON.parse(await readFile(planPath,'utf8'));
if (resolve(plan.packageRoot)!==root || resolve(dirname(planPath))!==resolve(plan.configDir,'logs')
  || !Array.isArray(plan.identities) || !plan.identities.length || plan.identities.length>3
  || plan.identities.some(p=>!Number.isInteger(p.pid)||p.pid<1||!p.createdAt)) throw new Error('Invalid replacement identity plan');
const resultPath=join(plan.configDir,'logs','stable-gateway-whole-restart-result.json');
const status={ok:false,state:'worker-started',startedAt:new Date().toISOString(),
  oldPids:plan.identities.map(p=>p.pid),gatewayPort:plan.gatewayPort,jobPreserved:true,quietVerified:false,secretValuesLogged:false};
const save=async(state,extra={})=>{Object.assign(status,extra,{state,updatedAt:new Date().toISOString()});await atomicWriteJson(resultPath,status);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function snapshot(){const r=await fetch(`http://127.0.0.1:${plan.gatewayPort}/__devspace/live/snapshot`,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw new Error('Gateway snapshot unavailable');return r.json();}
function quiet(s){return s.gateway?.admission?.closed===false && s.gateway.admission.activeRequests===0 && s.activity?.running===0;}
async function jobProbe(){
  const text=await new Promise((resolveProbe,rejectProbe)=>{
    const child=spawn('python',[join(root,'scripts','devspace-runtime-safety-probe.py'),...plan.identities.map(p=>String(p.pid))],{detached:true,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='';child.stdout.on('data',d=>{out+=d.toString('utf8');});child.stderr.resume();child.once('error',rejectProbe);
    child.once('close',code=>code===0?resolveProbe(out):rejectProbe(new Error('Job inspection failed')));
  });
  return JSON.parse(text).currentJob;
}
try{
  await save('waiting-for-quiet');
  await sleep(Math.max(1000,Math.min(30000,Number(plan.delaySeconds||6)*1000)));
  let consecutive=0;const deadline=Date.now()+120_000;
  while(consecutive<3){
    if(Date.now()>deadline)throw new Error('No quiet window; no process stopped');
    consecutive=quiet(await snapshot())?consecutive+1:0;
    await sleep(300);
  }
  const processes=await queryListenerProcesses(plan.identities.map(p=>p.pid));
  for(const p of plan.identities){
    const actual=processes.find(x=>x.processId===p.pid);
    if(!actual || actual.createdAt!==p.createdAt)throw new Error('Process identity changed; no process stopped');
  }
  const job=await jobProbe();
  if(!job.queryOk || !job.limitsQueryOk || job.killOnJobClose!==false
    || !plan.identities.every(p=>job.requestedPidsInCurrentJob.includes(p.pid)))throw new Error('Job safety cannot be confirmed; no process stopped');
  if(!quiet(await snapshot()))throw new Error('Work resumed before replacement; no process stopped');
  if(process.argv.includes('--preflight-only')){
    await save('preflight-verified',{ok:true,quietVerified:true,completedAt:new Date().toISOString()});
    process.exit(0);
  }
  await save('replacing-exact-processes',{quietVerified:true});
  // Gateway first, so it cannot respawn the old Core while it is being retired.
  for(const p of [...plan.identities].sort((a,b)=>(a.role==='gateway'?-1:1)-(b.role==='gateway'?-1:1))){
    try{process.kill(p.pid);}catch(error){if(error.code!=='ESRCH')throw error;}
  }
  await sleep(500);
  await save('starting-canonical-launcher');
  const launcher=spawn(process.execPath,[join(root,'scripts','devspace-fixed-backend.mjs'),'--foreground','--config-dir',plan.configDir],{
    cwd:root,detached:true,windowsHide:true,stdio:'ignore',
  });
  launcher.unref();
  let launchError=null;
  launcher.once('error',error=>{launchError=error;});
  launcher.once('exit',code=>{if(code!==0)launchError=new Error(`Launcher exited with ${code}`);});
  await save('awaiting-core-ready',{launcherPid:launcher.pid});
  while(true){
    if(launchError)throw launchError;
    await sleep(500);
    try{
      const s=await snapshot();
      const m=await fetch(`http://127.0.0.1:${plan.gatewayPort}/__devspace/memory/status`,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
      if(s.gateway?.ok===true && m.pid>0 && !status.oldPids.includes(m.pid)){
        await save('ready',{ok:true,newCorePid:m.pid,completedAt:new Date().toISOString()});break;
      }
    }catch{}
  }
}catch(error){await save('failed',{error:error.message,completedAt:new Date().toISOString()});process.exitCode=1;}
