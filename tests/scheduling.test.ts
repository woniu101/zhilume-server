import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { route, validateGraph, fingerprint } from '../src/execution.js';
import { startWorker, stopWorker } from './worker-helper.js';
const pause = (ms:number) => new Promise(r=>setTimeout(r,ms));
async function wait(get:()=>Promise<any>, predicate:(v:any)=>boolean) { let last; for(let i=0;i<200;i++){last=await get();if(predicate(last))return last;await pause(50);}throw Error(JSON.stringify(last)); }

test('routing uses exact specifications, readiness and physical resource ownership',()=>{
  const profile={modelId:'qwen-image-2512',profileId:'spec-one',workflowRevision:'revision',operations:['image.generate.v1']};
  const worker=(id:string,gpu:string,p=profile)=>({id,connected:true,lastHeartbeat:Date.now(),capabilities:['image.generate.v1'],imageProfiles:[p],deployment:{capacity:1,resourceIds:[gpu]}});
  const a=worker('a','gpu-1'),b=worker('b','gpu-2'),sameGpu=worker('duplicate','gpu-1'),different=worker('other','gpu-3',{...profile,profileId:'quantized-spec'});
  const job={operation:'image.generate.v1',input:profile};
  const occupied={executor:'worker',status:'running',workerId:'a',resourceIds:['gpu-1']};
  assert.equal(route(job,[a,sameGpu,different,b],[occupied],()=>true).worker?.id,'b');
  assert.equal(route(job,[a,sameGpu,different],[occupied],()=>true).reason,'resource_busy');
  assert.equal(route({...job,targetWorkerId:'missing'},[a,b],[],()=>true).reason,'model_offline');
  assert.equal(route(job,[{...b,connected:false}],[],()=>true).reason,'model_offline');
  assert.equal(route(job,[different],[],()=>true).worker,undefined);
  assert.throws(()=>validateGraph([{key:'a',bindings:[{from:'b',target:'text'}]},{key:'b',bindings:[{from:'a',target:'text'}]}],'workflow'),/循环/);
});

test('two real CPU workers: parallel batch, FIFO queue, offline bypass, dependencies, cancellation, immutable idempotency', {timeout:45000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'zhilume-scheduling-')), app=await createApp({root:join(root,'server'),token:'test-only',tickMs:25});
  const peers:any[]=[];t.after(async()=>{for(const p of peers)await stopWorker(p.child);await app.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const call=async(path:string,payload?:any)=>{const r=await app.inject({method:payload?'POST':'GET',url:'/api/v1'+path,headers:{authorization:'Bearer test-only'},payload});assert.ok(r.statusCode<300,r.body);return r.json();};
  const project=await call('/projects',{name:'调度验收'});
  for(let i=0;i<2;i++){const p=await startWorker(join(root,'worker'+i),['--delay','1.5']);peers.push(p);await call('/workers',{address:p.address,credential:p.credential,name:'CPU '+i});}
  await wait(()=>call('/workers'),v=>v.every((w:any)=>w.connected));
  const request={requestId:crypto.randomUUID(),projectId:project.id,mode:'batch',tasks:[0,1,2].map(i=>({key:'t'+i,operation:'mock.text.echo.v1',input:{text:'original '+i}}))};
  const batch=await call('/job-groups',request);
  const repeat=await call('/job-groups',structuredClone(request));assert.deepEqual(repeat.jobIds,batch.jobIds);
  const active=await wait(()=>call('/jobs'),jobs=>jobs.filter((j:any)=>j.status==='running').length===2);
  assert.equal(new Set(active.filter((j:any)=>j.status==='running').map((j:any)=>j.workerId)).size,2);
  assert.equal(active.filter((j:any)=>j.status==='queued').length,1);
  request.tasks[0].input.text='changed after submission';
  const conflict=await app.inject({method:'POST',url:'/api/v1/job-groups',headers:{authorization:'Bearer test-only'},payload:request});assert.equal(conflict.statusCode,409);
  const finished=await wait(()=>call('/jobs'),j=>j.length===3&&j.every((x:any)=>x.status==='succeeded'));
  assert.equal(finished.find((j:any)=>j.key==='t0').input.text,'original 0');
  const flow=await call('/job-groups',{requestId:crypto.randomUUID(),projectId:project.id,mode:'workflow',tasks:[
    {key:'up',operation:'mock.text.echo.v1',input:{text:'frozen upstream'}},
    {key:'down',operation:'mock.text.echo.v1',input:{text:''},bindings:[{from:'up',target:'text'}]},
    {key:'independent',operation:'mock.text.echo.v1',input:{text:'independent'}},
  ]});
  assert.equal(flow.jobs.find((j:any)=>j.key==='down').status,'waiting_upstream');
  await call(`/jobs/${flow.jobs.find((j:any)=>j.key==='up').id}/cancel`,{});
  const blocked=await wait(()=>call(`/jobs/${flow.jobs.find((j:any)=>j.key==='down').id}`),j=>j.status==='blocked');assert.equal(blocked.waitReason,'upstream_failed');
  await wait(()=>call(`/jobs/${flow.jobs.find((j:any)=>j.key==='independent').id}`),j=>j.status==='succeeded');
  await call(`/jobs/${flow.jobs.find((j:any)=>j.key==='up').id}/retry`,{});
  await call(`/jobs/${blocked.id}/retry`,{});
  const down=await wait(()=>call(`/jobs/${blocked.id}`),j=>j.status==='succeeded');assert.equal(down.input.text,'frozen upstream');assert.ok(down.outputAssetId);
  await stopWorker(peers[0].child);
  await wait(()=>call('/workers'),v=>v.some((w:any)=>!w.connected));
  const offline=await call('/jobs',{requestId:crypto.randomUUID(),projectId:project.id,operation:'mock.text.echo.v1',targetWorkerId:peers[0].workerId,input:{text:'waiting'}});
  await wait(()=>call(`/jobs/${offline.id}`),j=>j.waitReason==='model_offline');
  const bypass=await call('/jobs',{requestId:crypto.randomUUID(),projectId:project.id,operation:'mock.text.echo.v1',input:{text:'not blocked'}});
  await wait(()=>call(`/jobs/${bypass.id}`),j=>j.status==='succeeded');
  const cancelled=await call(`/jobs/${offline.id}/cancel`,{});assert.equal(cancelled.status,'cancelled');
});

test('internet API queue, secret isolation, optional optimization, capability rejection and cancellation', {timeout:30000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'zhilume-language-')),app=await createApp({root,token:'test-only',tickMs:25});
  const requests:any[]=[];
  const provider=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);requests.push(b);assert.equal(req.headers.authorization,'Bearer secret-never-export');
    const content=b.messages.at(-1).content;
    if(content==='hold')await pause(3000);
    if(content==='fail'){res.writeHead(500);res.end('secret-never-export');return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:b.response_format?'{}':'suggestion: '+content}}]}));});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(async()=>{await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const call=async(path:string,payload?:any)=>{const r=await app.inject({method:payload?'POST':'GET',url:'/api/v1'+path,headers:{authorization:'Bearer test-only'},payload});assert.ok(r.statusCode<300,r.body);return r.json();};
  const p=await call('/language/providers',{name:'Fixture',baseUrl:`http://127.0.0.1:${(provider.address() as any).port}/v1`,apiKey:'secret-never-export',models:[{model:'fixture-v1',capabilities:['text']}],defaults:{text:'fixture-v1',h3:'fixture-v1'}});
  assert.ok(!JSON.stringify(p).includes('secret-never-export'));assert.ok(!(await readFile(join(root,'language-vault.enc'))).includes(Buffer.from('secret-never-export')));
  const project=await call('/projects',{name:'API test'}),model=(await call('/language/models'))[0];
  const body=(text:string)=>({requestId:crypto.randomUUID(),projectId:project.id,operation:'prompt.optimize.v1',input:{profileId:model.profileId,purpose:'h3',text}});
  const initial=body('original'),j=await call('/jobs',initial);initial.input.text='edited locally';
  const result=await wait(()=>call(`/jobs/${j.id}`),v=>v.status==='succeeded');assert.equal(result.input.text,'original');assert.equal(result.outputText,'suggestion: original');assert.ok(!JSON.stringify(result).includes('secret-never-export'));
  const invalid=await app.inject({method:'POST',url:'/api/v1/jobs',headers:{authorization:'Bearer test-only'},payload:{...body('test'),input:{profileId:model.profileId,text:'test',schema:{type:'object'}}}});assert.equal(invalid.statusCode,400);
  const hold=await call('/jobs',body('hold')),waiting=await call('/jobs',body('second'));assert.equal(waiting.status,'queued');
  await call(`/jobs/${hold.id}/cancel`,{});await wait(()=>call(`/jobs/${hold.id}`),v=>v.status==='cancelled');await wait(()=>call(`/jobs/${waiting.id}`),v=>v.status==='succeeded');
  const failure=await call('/jobs',body('fail'));const failed=await wait(()=>call(`/jobs/${failure.id}`),v=>v.status==='failed');assert.equal(failed.input.text,'fail');assert.ok(!JSON.stringify(failed).includes('secret-never-export'));
  assert.equal(requests[0].messages[0].role,'system');
});
