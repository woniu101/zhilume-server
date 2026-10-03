import { createResultNode, assertNodeResult } from './result-helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import ffmpeg from 'ffmpeg-static';
import { createApp } from '../src/server.js';
import { videoModels } from '../src/video-operations.js';
import { startWorker, stopWorker } from './worker-helper.js';

test('H3 transport: explicit references, MP4 archive, cancellation and recovery without Server ingress', {timeout:60000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'zhilume-video-test-'));
  const app=await createApp({root:join(root,'server'),token:'video-test-only',tickMs:50});
  const config=JSON.parse(await readFile('../zhilume-worker/config/video.example.json','utf8'));
  config.profiles.forEach((p: any) => { p.identity = { revision: 'fixture-v1', quantization: 'fp32', artifacts: Object.fromEntries(Object.keys(p.models).map(k => [k, 'revision:fixture-v1-'+k])) }; });
  config.ffmpeg=ffmpeg;
  config.ffprobe=process.env.ZHILUME_TEST_FFPROBE || execFileSync(process.platform==='win32'?'where.exe':'which',['ffprobe'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0];
  const output=join(root,'fixture.mp4');
  execFileSync(ffmpeg!,['-v','error','-f','lavfi','-i','color=c=blue:s=512x288:r=24','-frames:v','124','-c:v','libx264','-pix_fmt','yuv420p',output],{windowsHide:true});
  const mp4=await readFile(output),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2kAAAAASUVORK5CYII=','base64');
  const info:any=Object.fromEntries(videoModels.flatMap(m=>m.requiredNodes).map(n=>[n,{}]));
  for(const [node,field,keys] of [['UNETLoader','unet_name',['diffusion']],['CLIPLoader','clip_name',['clip']],['VAELoader','vae_name',['vae','audioVae']]] as const)
    info[node]={input:{required:{[field]:[config.profiles.flatMap((p:any)=>keys.map(k=>p.models[k]))]}}};
  let active:string|null=null,hold=false;const graphs:any[]=[],interrupted:string[]=[];
  const comfy=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    const raw=Buffer.concat(chunks),path=new URL(req.url!,'http://local').pathname;
    const body=req.headers['content-type']?.includes('application/json')?JSON.parse(raw.toString()):null;let result:any={};
    if(path==='/system_stats')result={devices:[]};
    else if(path==='/object_info')result=info;
    else if(path==='/queue')result={queue_running:active?[[0,active]]:[],queue_pending:[]};
    else if(path==='/upload/image')result={name:'reference.png',subfolder:''};
    else if(path==='/prompt'){graphs.push(body);active=body.prompt_id;result={prompt_id:active};}
    else if(path.startsWith('/history/')&&!hold){result={[path.split('/').pop()!]:{status:{completed:true},outputs:{output:{images:[{filename:'output.mp4',subfolder:'',type:'output'}]}}}};active=null;}
    else if(path==='/view'){res.end(mp4);return;}
    else if(path==='/interrupt'){interrupted.push(body.prompt_id);assert.equal(active,body.prompt_id);active=null;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
  });
  let peer:Awaited<ReturnType<typeof startWorker>>|undefined;
  t.after(async()=>{await stopWorker(peer?.child);await app.close();await new Promise<void>(r=>comfy.close(()=>r()));if(resolve(root).startsWith(resolve(tmpdir())+sep+'zhilume-video-test-'))await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  comfy.listen(0,'127.0.0.1');await once(comfy,'listening');config.url=`http://127.0.0.1:${(comfy.address() as any).port}`;
  const configPath=join(root,'video.json');await writeFile(configPath,JSON.stringify(config));
  const headers={Authorization:'Bearer video-test-only'};
  const call=async(path:string,payload?:any)=>{const r=await app.inject({method:payload?'POST':'GET',url:'/api/v1'+path,headers,payload});assert.ok(r.statusCode<300,r.body);return r.json();};
  async function wait(get:()=>Promise<any>,ready:(v:any)=>boolean){for(let i=0;i<200;i++){const v=await get();if(ready(v))return v;await new Promise(r=>setTimeout(r,100));}throw Error('timeout '+peer?.log());}
  peer=await startWorker(join(root,'worker'),['--video-config',configPath,'--enable-video-execution']);
  await call('/workers',{address:peer.address,credential:peer.credential});
  const models=await wait(()=>call('/video-models'),v=>v.every((m:any)=>m.ready));
  const project=await call('/projects',{name:'H3 CPU fixture'});
  const upload=await app.inject({method:'POST',url:'/api/v1/assets/uploads?filename=ref.png',headers:{...headers,'Content-Type':'application/octet-stream'},payload:png});assert.equal(upload.statusCode,201);const asset=upload.json();
  await createResultNode(app,headers,project.id,'video');
  const body=(reference=false)=>{const p=models[reference?1:0].profiles[0];return {requestId:crypto.randomUUID(),projectId:project.id,nodeId:'result-target',operation:'video.generate.v1',input:{modelId:p.modelId,profileId:p.profileId,workflowRevision:p.workflowRevision,mode:reference?'reference':'text',prompt:'A blue sphere',width:512,height:288,frames:124,steps:20,seed:0,includeAudio:false,references:reference?[{role:'image',assetId:asset.id}]:[]}};};
  for(const reference of [false,true]){
    const b=body(reference),job=await call('/jobs',b);assert.equal((await call('/jobs',b)).id,job.id);
    const done=await wait(()=>call('/jobs/'+job.id),j=>['succeeded','failed'].includes(j.status));assert.equal(done.status,'succeeded',JSON.stringify(done));await assertNodeResult(app,headers,project.id,done,'video');
    const result=await call('/assets/'+done.outputAssetId);assert.equal(result.kind,'video');assert.deepEqual(result.provenance.sourceAssetIds,reference?[asset.id]:[]);assert.equal(result.provenance.parameters.frames,124);
  }
  assert.equal(graphs[1].prompt.condition.inputs['ref_images.ref_image_1'][0],'reference_0');
  hold=true;const held=await call('/jobs',body());await wait(async()=>active,v=>!!v);await call('/jobs/'+held.id+'/cancel',{});
  const cancelled=await wait(()=>call('/jobs/'+held.id),j=>j.status==='cancelled');assert.ok(!cancelled.outputAssetId);assert.equal(interrupted.length,1);
  hold=false;const next=await call('/jobs',body());assert.equal((await wait(()=>call('/jobs/'+next.id),j=>['succeeded','failed'].includes(j.status))).status,'succeeded');
});
