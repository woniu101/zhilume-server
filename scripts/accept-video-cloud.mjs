// Explicit real GPU acceptance; does not start an instance or require Server ingress.
import { createApp } from '../dist/server.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import assert from 'node:assert/strict';
const mode=process.argv[2];
assert.ok(['text','first-last','reference','cancel','after-cancel'].includes(mode) && process.argv.includes('--execute'),'mode and --execute required (real GPU)');
for(const key of ['ZHILUME_WORKER_ADDRESS','ZHILUME_WORKER_TOKEN'])assert.ok(process.env[key],key+' required');
const root=resolve(process.env.ZHILUME_ACCEPTANCE_DIR||'artifacts/video-acceptance');await mkdir(join(root,'outputs'),{recursive:true});
const token=randomUUID(),app=await createApp({root:join(root,'server-data'),token,tickMs:500});
const headers={Authorization:'Bearer '+token};
async function call(path,payload){const r=await app.inject({method:payload?'POST':'GET',url:'/api/v1'+path,headers,payload});assert.ok(r.statusCode<300,r.body);return r.json();}
async function wait(get,ready,seconds=120){const until=Date.now()+seconds*1000;while(Date.now()<until){const value=await get();if(ready(value))return value;await new Promise(r=>setTimeout(r,1000));}throw Error('Acceptance timed out');}
async function upload(file){assert.ok(file,'Reference file required');const r=await app.inject({method:'POST',url:'/api/v1/assets/uploads?filename='+encodeURIComponent(basename(file)),headers:{...headers,'Content-Type':'application/octet-stream'},payload:await readFile(file)});assert.equal(r.statusCode,201,r.body);return r.json();}
let job;
try{
  if(!(await call('/workers')).length)await call('/workers',{address:process.env.ZHILUME_WORKER_ADDRESS,credential:process.env.ZHILUME_WORKER_TOKEN});
  const models=await wait(()=>call('/video-models'),v=>v.every(m=>m.ready));
  const p=models.find(m=>m.id===('minimax-h3-'+(mode==='reference'?'ref2va':'fl2va'))).profiles[0];
  const project=await call('/projects',{name:'上海二 A H3 真实验收 '+mode}),references=[];
  if(mode==='first-last')for(const role of ['first','last'])references.push({role,assetId:(await upload(process.env.ZHILUME_IMAGE_FILE)).id});
  if(mode==='reference')for(const [role,key] of [['image','ZHILUME_IMAGE_FILE'],['video','ZHILUME_VIDEO_FILE'],['audio','ZHILUME_AUDIO_FILE']])references.push({role,assetId:(await upload(process.env[key])).id,...(role==='image'?{}:{start:0,frames:56})});
  const input={modelId:p.modelId,profileId:p.profileId,workflowRevision:p.workflowRevision,mode:['cancel','after-cancel'].includes(mode)?'text':mode,
    prompt:mode==='reference'?'The scene follows the visual palette of <Picture 1>. Use the gentle movement from <Video 1> and soft ambient sound from <Audio 1>. A smooth camera pan.':'A small blue sphere slowly rotates on a wooden table in warm daylight. Static camera. Gentle room ambience.',
    width:512,height:288,frames:124,steps:mode==='cancel'?50:20,seed:mode==='cancel'?99:mode==='after-cancel'?100:42,includeAudio:mode!=='first-last',references};
  const body={requestId:randomUUID(),projectId:project.id,operation:'video.generate.v1',input},started=Date.now();
  job=await call('/jobs',body);assert.equal((await call('/jobs',body)).id,job.id);console.log(JSON.stringify({mode,jobId:job.id,started:new Date().toISOString()}));
  if(mode==='cancel'){
    await wait(()=>call('/jobs/'+job.id),j=>{if(j.status==='failed')throw Error(j.error);return j.stage?.includes('模型执行中');});
    await new Promise(r=>setTimeout(r,10000));await call('/jobs/'+job.id+'/cancel',{});
  }
  let last;const done=await wait(()=>call('/jobs/'+job.id),j=>{const state=j.status+':'+j.stage;if(state!==last){console.log(state);last=state;}return ['succeeded','failed','cancelled'].includes(j.status);},3600);
  const record={mode,elapsedSeconds:(Date.now()-started)/1000,profile:p,job:done,serverListened:false};
  if(done.status==='succeeded'){
    const asset=await call('/assets/'+done.outputAssetId),r=await app.inject({method:'GET',url:'/api/v1/assets/'+asset.id+'/content',headers});
    assert.equal(r.statusCode,200);assert.equal(createHash('sha256').update(r.rawPayload).digest('hex'),asset.sha256);assert.equal(asset.kind,'video');
    assert.deepEqual(asset.provenance.sourceAssetIds,[...new Set(references.map(r=>r.assetId))]);record.asset=asset;await writeFile(join(root,'outputs',mode+'.mp4'),r.rawPayload);
  }
  await writeFile(join(root,mode+'-result.json'),JSON.stringify(record,(k,v)=>['url','downloadUrl'].includes(k)?undefined:v,2));
  console.log(JSON.stringify({mode,status:done.status,elapsedSeconds:record.elapsedSeconds,error:done.error}));assert.equal(done.status,mode==='cancel'?'cancelled':'succeeded');
}catch(e){if(job)await call('/jobs/'+job.id+'/cancel',{}).catch(()=>{});throw e;}finally{await app.close();}
