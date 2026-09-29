import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { archiveNodeResult } from '../src/node-results.js';

test('frozen destination, archived results, restart, idempotency, type lock and retry exclusion', {timeout:30000}, async t => {
  const root=await mkdtemp(join(tmpdir(),'zhilume-node-results-'));
  let app=await createApp({root,token:'fixture',tickMs:20});
  let release=()=>{}; let accepted=false;
  const provider=createServer(async(req,res)=>{
    for await(const _ of req) { /* drain input */ }
    await new Promise<void>(r=>{release=r;accepted=true;});
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'archived text'}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(async()=>{release();await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const req=(path:string,payload?:any,method:any=payload?'POST':'GET')=>app.inject({method,url:'/api/v1'+path,headers:{authorization:'Bearer fixture'},payload});
  const call=async(path:string,payload?:any,method?:any)=>{const r=await req(path,payload,method);assert.ok(r.statusCode<300,r.body);return r.json();};
  const wait=async(path:string,predicate:(v:any)=>boolean)=>{for(let i=0;i<150;i++){const v=await call(path);if(predicate(v))return v;await new Promise(r=>setTimeout(r,25));}throw Error('timeout '+path);};
  await call('/language/providers',{name:'Local fixture',baseUrl:`http://127.0.0.1:${(provider.address() as any).port}/v1`,apiKey:'fixture',models:[{model:'test',capabilities:['text']}],defaults:{text:'test'}});
  const model=(await call('/language/models'))[0],project=await call('/projects',{name:'Result ownership'}),url=`/projects/${project.id}`;
  const doc={schemaVersion:1,baseRevision:0,nodes:[{id:'text',type:'media',position:{x:0,y:0},data:{kind:'text',title:'文本1',contentSchemaVersion:1,contentRevision:0}}],edges:[]};
  await call(url+'/canvas',doc,'PUT');
  const body={requestId:'first',projectId:project.id,nodeId:'text',operation:'text.generate.v1',input:{profileId:model.profileId,text:'original'},resultTarget:{nodeId:'injected'}};
  const job=await call('/jobs',body);
  assert.equal(job.resultTarget.nodeId,'text');assert.equal(job.resultTarget.base.revision,0);
  assert.equal((await call('/jobs',body)).id,job.id);
  assert.equal((await req('/jobs',{...body,requestId:'second'})).json().code,'node_busy');
  const locked=await req(url+'/canvas',{...doc,baseRevision:1,nodes:[{...doc.nodes[0],data:{...doc.nodes[0].data,kind:'image'}}]},'PUT');
  assert.equal(locked.json().code,'node_kind_locked');
  await call(url+'/canvas',{...doc,baseRevision:1,nodes:[{...doc.nodes[0],data:{...doc.nodes[0].data,text:'later edit',contentRevision:1}}]},'PUT');
  // Wait until the local provider has accepted the request, then let the job finish without Studio.
  await wait('/jobs/'+job.id,j=>j.status==='running');
  for(let i=0;i<100 && !accepted;i++)await new Promise(r=>setTimeout(r,10));
  release();await wait('/jobs/'+job.id,j=>j.status==='succeeded');
  const results=await call(url+'/node-results');
  assert.equal(results.length,1);assert.equal(results[0].base.revision,0);assert.equal(results[0].output.text,'archived text');
  assert.equal((await call(url+'/canvas')).nodes[0].data.text,'later edit');
  archiveNodeResult((app as any).store,(app as any).store.get('job',job.id));
  assert.equal((await call(url+'/node-results')).length,1);
  assert.equal((await app.inject({url:'/api/v1'+url+'/node-results'})).statusCode,401);
  await app.close();app=await createApp({root,token:'fixture',tickMs:20});
  assert.equal((await call(url+'/node-results'))[0].output.text,'archived text');
  // Cancelled attempts can be retried only when their destination has no newer active task.
  const old=await call('/jobs',{...body,requestId:'cancel-me'});
  await call('/jobs/'+old.id+'/cancel',{});
  await wait('/jobs/'+old.id,j=>j.status==='cancelled');
  const newer=await call('/jobs',{...body,requestId:'newer'});
  assert.equal((await req('/jobs/'+old.id+'/retry',{})).json().code,'node_busy');
  await call('/jobs/'+newer.id+'/cancel',{});
});
