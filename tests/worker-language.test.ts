import { createResultNode, assertNodeResult } from './result-helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server.js';
import { startWorker, stopWorker } from './worker-helper.js';

test('language Workers: exact-spec aggregation, GPU routing, parallel, FIFO, freeze, cancel, offline and dependency failure', {timeout:60000}, async t => {
  const root=await mkdtemp(join(tmpdir(),'zhilume-worker-language-'));
  const app=await createApp({root:join(root,'server'),token:'test-only',tickMs:25});
  const peers:any[]=[];
  t.after(async()=>{for(const p of peers) await stopWorker(p.child);await app.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const call=async(path:string,payload?:any)=>{const r=await app.inject({method:payload?'POST':'GET',url:'/api/v1'+path,headers:{authorization:'Bearer test-only'},payload});assert.ok(r.statusCode<300,r.body);return r.json();};
  const wait=async(path:string,predicate:(v:any)=>boolean)=>{let last;for(let i=0;i<300;i++){last=await call(path);if(predicate(last))return last;await new Promise(r=>setTimeout(r,50));}throw Error(JSON.stringify(last));};
  for(let i=0;i<2;i++){const p=await startWorker(join(root,'w'+i),[],undefined,false,resolve('../zhilume-worker/tests/language_worker.py'));peers.push(p);await call('/workers',{name:'language '+i,address:p.address,credential:p.credential});}
  const models=await wait('/language/models',v=>v[0]?.readyCount===2),profile=models[0];
  assert.equal(models.length,1);assert.equal(profile.executor,'worker');
  const project=await call('/projects',{name:'LLM transport fixture'});
  await createResultNode(app,{authorization:'Bearer test-only'},project.id,'text');
  const body=(text:string)=>({requestId:crypto.randomUUID(),projectId:project.id,operation:'text.generate.v1',input:{profileId:profile.profileId,text}});
  const first=body('hold'), a=await call('/jobs',first), b=await call('/jobs',body('hold')), c=await call('/jobs',{...body('original'),nodeId:'result-target'});
  assert.equal(a.executor,'worker');assert.equal((await call('/jobs',first)).id,a.id);
  first.input.text='edited';
  const running=await wait('/jobs',v=>v.filter((j:any)=>j.status==='running').length===2);
  assert.equal(new Set(running.filter((j:any)=>j.status==='running').map((j:any)=>j.workerId)).size,2);
  assert.equal((await call('/jobs/'+c.id)).status,'queued');
  await call('/jobs/'+a.id+'/cancel',{});await wait('/jobs/'+a.id,j=>j.status==='cancelled');
  const done=await wait('/jobs/'+c.id,j=>j.status==='succeeded');assert.equal(done.outputText,'result: original');assert.ok(done.outputAssetId);await assertNodeResult(app,{authorization:'Bearer test-only'},project.id,done,'text');
  await call('/jobs/'+b.id+'/cancel',{});await wait('/jobs/'+b.id,j=>j.status==='cancelled');
  const flow=await call('/job-groups',{requestId:crypto.randomUUID(),projectId:project.id,mode:'workflow',tasks:[
    {key:'up',operation:'text.generate.v1',input:{profileId:profile.profileId,text:'fail'}},
    {key:'down',operation:'text.generate.v1',input:{profileId:profile.profileId,text:''},bindings:[{from:'up',target:'text'}]},
    {key:'free',operation:'prompt.optimize.v1',input:{profileId:profile.profileId,text:'draft',purpose:'qwen'}},
  ]});
  await wait('/jobs/'+flow.jobs.find((j:any)=>j.key==='down').id,j=>j.status==='blocked');
  assert.equal((await wait('/jobs/'+flow.jobs.find((j:any)=>j.key==='free').id,j=>j.status==='succeeded')).outputText,'result: draft');
  await stopWorker(peers[0].child);await wait('/workers',v=>v.some((w:any)=>!w.connected));
  const offline=await call('/jobs',{...body('offline'),targetWorkerId:peers[0].workerId});
  await wait('/jobs/'+offline.id,j=>j.waitReason==='model_offline');
  const bypass=await call('/jobs',body('bypass'));await wait('/jobs/'+bypass.id,j=>j.status==='succeeded');
  await call('/jobs/'+offline.id+'/cancel',{});
});
