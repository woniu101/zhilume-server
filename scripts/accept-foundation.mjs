// Explicit live GPU acceptance; credentials are supplied only through the environment.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createApp } from '../dist/server.js';
if (!process.argv.includes('--execute')) throw Error('Real GPU test requires --execute');
const root = resolve(process.env.ZHILUME_ACCEPTANCE_DIR);
await mkdir(root, {recursive:true});
const address=process.env.ZHILUME_WORKER_ADDRESS, credential=process.env.ZHILUME_WORKER_TOKEN, admin=process.env.ZHILUME_MANAGEMENT_TOKEN;
const app=await createApp({root:join(root,'server-data'),token:'local-foundation-fixture',tickMs:200});
const evidence={startedAt:new Date().toISOString(), serverListening:app.server.listening, results:[], managementLatencyMs:[]};
async function api(path,body){const r=await app.inject({method:body?'POST':'GET',url:'/api/v1'+path,headers:{Authorization:'Bearer local-foundation-fixture'},payload:body});assert.ok(r.statusCode<300,r.body);return r.json();}
async function manage(path,body){const start=Date.now();const r=await fetch(address+'/management/api/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});assert.ok(r.ok,'management status '+r.status);const data=await r.json();if(path==='overview')evidence.managementLatencyMs.push(Date.now()-start);return data;}
async function until(get,test,seconds=300){const end=Date.now()+seconds*1000;while(Date.now()<end){const v=await get();if(test(v))return v;await new Promise(r=>setTimeout(r,1000));}throw Error('Timed out');}
async function enable(kind){const {operationId}=await manage('executors/'+kind+'/enable',{});const op=await until(()=>manage('operations'),rows=>rows.some(o=>o.id===operationId&&o.state!=='running'),120);const result=op.find(o=>o.id===operationId);assert.equal(result.state,'succeeded',JSON.stringify(result));console.log(kind,'ready');}
async function settled(job,expected='succeeded'){
 const final=await until(()=>api('/jobs/'+job.id),j=>['succeeded','failed','cancelled','interrupted'].includes(j.status));
 assert.equal(final.status,expected,JSON.stringify({status:final.status,error:final.error}));
 const overview=await until(()=>manage('overview'),o=>!o.tasks.length,90);
 assert.equal(overview.resourceQuarantined,false);
 assert.ok(overview.gpus.every(g=>Number(g.usedMiB)<1536),'Physical GPU occupancy has not returned to idle');
 evidence.results.push({operation:job.operation,status:final.status,jobId:job.id,profileId:final.input.profileId,output:final.output?{id:final.output.id,size:final.output.size,sha256:final.output.sha256}:null,gpus:overview.gpus});
 console.log(job.operation,final.status,'resources released');return final;
}
try{
 await enable('image');await enable('speech');
 const all=await api('/workers');if(!all.length)await api('/workers',{address,credential});
 const models=await until(()=>api('/models'),m=>m.image.some(x=>x.id==='qwen-image-2512'&&x.ready)&&m.speech.some(x=>x.ready));
 const image=models.image.find(x=>x.id==='qwen-image-2512').profiles[0],speech=models.speech[0].profiles[0];
 const project=await api('/projects',{name:'统一模型与资源释放 GPU 验收'});
 const submit=(operation,input)=>api('/jobs',{requestId:crypto.randomUUID(),projectId:project.id,operation,input});
 const imageInput={modelId:image.modelId,profileId:image.profileId,workflowRevision:image.workflowRevision,prompt:'A small blue ceramic cup on a wooden table, soft daylight.',negativePrompt:'',referenceAssetIds:[],width:512,height:512,steps:5,seed:27,outputFormat:'png'};
 const first=await submit('image.generate.v1',imageInput), queued=await submit('image.generate.v1',imageInput);
 assert.equal(queued.status,'queued');await api('/jobs/'+queued.id+'/cancel',{});assert.equal((await api('/jobs/'+queued.id)).status,'cancelled');
 await manage('overview');await settled(first);
 const bytes=await readFile(process.env.ZHILUME_AUDIO_FILE);
 const upload=await app.inject({method:'POST',url:'/api/v1/assets/uploads?filename=speaker.wav',headers:{Authorization:'Bearer local-foundation-fixture','Content-Type':'application/octet-stream'},payload:bytes});assert.ok(upload.statusCode<300,upload.body);const asset=upload.json();
 const audio=await submit('audio.speech.v1',{modelId:speech.modelId,profileId:speech.profileId,workflowRevision:speech.workflowRevision,text:'这是织镜的执行器切换测试。',language:'ZH',speed:1,speaker:{assetId:asset.id,start:0,end:2},emotionMode:'follow',emotionAlpha:.6,emotionVector:Array(8).fill(0),emotionText:'',emotionReference:{assetId:'',start:0,end:2}});
 await manage('overview');await settled(audio);
 const cancel=await submit('image.generate.v1',{...imageInput,width:1024,height:1024,steps:50});
 await until(()=>api('/jobs/'+cancel.id),j=>j.status==='running');
 await new Promise(r=>setTimeout(r,10000));await manage('overview');await api('/jobs/'+cancel.id+'/cancel',{});await settled(cancel,'cancelled');
 evidence.finishedAt=new Date().toISOString();evidence.serverListening=app.server.listening;
 await writeFile(join(root,'result.json'),JSON.stringify(evidence,null,2));
 console.log('GPU_FOUNDATION_ACCEPTED',JSON.stringify(evidence));
}finally{await app.close();}
