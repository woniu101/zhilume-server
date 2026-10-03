// Explicit real inference acceptance. Does not provision machines or buy capacity.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, join, basename } from 'node:path';
import { createApp } from '../dist/server.js';
import { chromium, expect } from '../../zhilume-studio/node_modules/@playwright/test/index.mjs';

assert.ok(process.argv.includes('--execute'), 'Real GPU acceptance requires --execute');
for (const key of ['ZHILUME_ACCEPTANCE_DIR','ZHILUME_WORKER_ADDRESS','ZHILUME_WORKER_TOKEN','ZHILUME_MANAGEMENT_TOKEN','ZHILUME_SERVER_DATA','ZHILUME_AUDIO_FILE']) assert.ok(process.env[key], key+' required');
const root = resolve(process.env.ZHILUME_ACCEPTANCE_DIR), data = join(root,'server-data');
await mkdir(data,{recursive:true});
// Preserve the operator-owned Worker binding, but use a fresh project/database.
await copyFile(join(process.env.ZHILUME_SERVER_DATA,'worker-connections.json'),join(data,'worker-connections.json'));
const token = randomUUID();
let app = await createApp({root:data,token,tickMs:200});
const headers = {authorization:'Bearer '+token}, address = process.env.ZHILUME_WORKER_ADDRESS;
const evidence = {startedAt:new Date().toISOString(),fixtureResponses:false,client:'Studio Web',results:[],operations:[]};
let browser, page, vite, project, currentJob;
const delay = ms => new Promise(r=>setTimeout(r,ms));
async function api(path,payload,method=payload?'POST':'GET') {
  const response=await app.inject({method,url:'/api/v1'+path,headers,payload});
  assert.ok(response.statusCode<300,response.body);return response.json();
}
async function until(get,predicate,seconds=180) {
  const end=Date.now()+seconds*1000;
  while(Date.now()<end){const value=await get();if(predicate(value))return value;await delay(500);}
  throw Error('Acceptance timed out');
}
async function manage(path,payload) {
  const response=await fetch(address+'/management/api/'+path,{method:payload?'POST':'GET',headers:{authorization:'Bearer '+process.env.ZHILUME_MANAGEMENT_TOKEN,'content-type':'application/json'},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(15000)});
  assert.ok(response.ok,'Management HTTP '+response.status);return response.json();
}
async function operation(path,payload={}) {
  console.log('OPERATION',path);
  const {operationId}=await manage(path,payload);
  const rows=await until(()=>manage('operations'),r=>r.some(o=>o.id===operationId&&o.state!=='running'),300);
  const op=rows.find(o=>o.id===operationId); evidence.operations.push({path,state:op.state,error:op.error});
  assert.equal(op.state,'succeeded',JSON.stringify(op));
}
async function upload(file) {
  const response=await app.inject({method:'POST',url:'/api/v1/assets/uploads?filename='+encodeURIComponent(basename(file)),headers:{...headers,'content-type':'application/octet-stream'},payload:await readFile(file)});
  assert.equal(response.statusCode,201,response.body);return response.json();
}
async function run(label,kind,nodeData,button,prompt) {
  const nodeId=randomUUID(),before=await api(`/projects/${project.id}/canvas`);
  await api(`/projects/${project.id}/canvas`,{schemaVersion:1,baseRevision:before.revision,viewport:{x:0,y:0,zoom:1},nodes:[{id:nodeId,type:'media',position:{x:500,y:160},style:{width:280,height:176},data:{kind,title:label,...nodeData}}],edges:[]},'PUT');
  await page.reload();await page.getByText(project.name,{exact:true}).click();
  const node=page.locator(`.react-flow__node[data-id="${nodeId}"]`);await node.click();
  const panel=page.locator('.node-composer');
  if(kind==='text')await panel.getByRole('button',{name:'生成文本',exact:true}).click();
  if(prompt)await panel.getByRole('textbox',{name:kind==='text'?'文本内容':'提示词',exact:true}).fill(prompt);
  const [response]=await Promise.all([
    page.waitForResponse(r=>r.url().endsWith('/api/v1/jobs')&&r.request().method()==='POST'),
    panel.locator('footer').getByRole('button',{name:button,exact:true}).click(),
  ]);
  assert.ok(response.ok(),await response.text());currentJob=await response.json();
  console.log('SUBMITTED',label,currentJob.id);
  if(label==='video-first') {
    const active=await until(()=>api('/jobs/'+currentJob.id),j=>j.stage?.includes('模型执行中'),180);
    const port=app.server.address().port;
    await app.close();await delay(12000);
    app=await createApp({root:data,token,tickMs:200});await app.listen({host:'127.0.0.1',port});
    const resumed=await api('/jobs/'+currentJob.id);assert.equal(resumed.attemptId,active.attemptId);
    evidence.serverRestart={jobId:active.id,attemptId:active.attemptId,offlineSeconds:12};
  }
  const started=Date.now();let last='';
  const done=await until(async()=>{
    const j=await api('/jobs/'+currentJob.id);if(j.stage!==last){console.log(label,j.status,j.stage);last=j.stage;}return j;
  },j=>['succeeded','failed','cancelled','interrupted'].includes(j.status),1200);
  assert.equal(done.status,'succeeded',done.error);
  if(label==='video-first')assert.equal(done.attemptId,evidence.serverRestart.attemptId,'recovery must not start a second inference');
  const canvas=await until(()=>api(`/projects/${project.id}/canvas`),c=>c.nodes[0]?.data.lastResultId===done.id||c.nodes[0]?.data.assetId===done.outputAssetId||(kind==='text'&&c.nodes[0]?.data.text===done.outputText),45);
  assert.equal(canvas.nodes.length,1);assert.equal(canvas.nodes[0].id,nodeId);
  const ledger=await api(`/projects/${project.id}/node-results`);assert.ok(ledger.some(r=>r.jobId===done.id));
  const asset=await api('/assets/'+done.outputAssetId);
  const bytes=await app.inject({method:'GET',url:'/api/v1/assets/'+asset.id+'/content',headers});
  assert.equal(createHash('sha256').update(bytes.rawPayload).digest('hex'),asset.sha256);
  await writeFile(join(root,label+'.'+({image:'png',video:'mp4',audio:'wav',text:'txt'}[kind])),bytes.rawPayload);
  await page.reload();await page.getByText(project.name,{exact:true}).click();
  if(kind==='text')await expect(node.locator('.text-preview')).toHaveText(done.outputText);
  else {await expect(node.locator(kind==='image'?'img':kind==='video'?'video':'audio').first()).toBeAttached();}
  await page.screenshot({path:join(root,label+'-studio.png')});
  const overview=await until(()=>manage('overview'),o=>!o.tasks.length,120);
  assert.equal(overview.resourceQuarantined,false);
  evidence.results.push({label,kind,jobId:done.id,nodeId,elapsedMs:Date.now()-started,canvasSaved:true,reopened:true,sha256:asset.sha256,size:asset.size,gpus:overview.gpus});
  await writeFile(join(root,'result.json'),JSON.stringify(evidence,null,2));
  console.log('PASSED',label);currentJob=undefined;return asset;
}
try {
  const overview=await manage('overview');assert.equal(overview.tasks.length,0);evidence.workerVersion=overview.version;
  const workers=await api('/workers'),worker=workers.find(w=>w.id===overview.workerId);
  if(worker)await api('/workers/'+worker.id,{address,credential:process.env.ZHILUME_WORKER_TOKEN,disabled:false,draining:false},'PATCH');
  else await api('/workers',{address,credential:process.env.ZHILUME_WORKER_TOKEN});
  await app.listen({host:'127.0.0.1',port:0});
  const base='http://127.0.0.1:'+app.server.address().port;
  vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5412','--strictPort'],{cwd:resolve('../zhilume-studio'),windowsHide:true,env:{...process.env,ZHILUME_DEV_SERVER:base},stdio:'ignore'});
  await until(async()=>{try{return (await fetch('http://127.0.0.1:5412')).ok;}catch{return false;}},Boolean,60);
  browser=await chromium.launch({channel:'chrome',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.addInitScript(token=>{sessionStorage.setItem('zhilume.session',token);},token);
  project=await api('/projects',{name:'Studio 0.20 创作闭环 '+Date.now()});
  if(process.argv.includes('--reference-only')) {
    assert.ok(process.env.ZHILUME_RESUME_DIR,'ZHILUME_RESUME_DIR required');
    await operation('runtimes/comfy-main/start');await operation('executors/video/enable');
    const videos=await until(()=>api('/video-models'),rows=>rows.some(m=>m.id==='minimax-h3-ref2va'&&m.ready));
    const profile=videos.find(m=>m.id==='minimax-h3-ref2va').profiles[0];
    const references=[];
    for(const [role,file] of [['image','image.png'],['video','video-first-last.mp4'],['audio','speech.wav']]) references.push({role,assetId:(await upload(join(process.env.ZHILUME_RESUME_DIR,file))).id,start:0,frames:56});
    await page.goto('http://127.0.0.1:5412');
    await run('video-reference','video',{videoDraft:{modelId:profile.modelId,profileId:profile.profileId,mode:'reference',prompt:'Follow the visual style of <Picture 1>, the motion of <Video 1> and the voice of <Audio 1>. A cup on a wooden table.',firstFrameId:'',lastFrameId:'',references,width:512,height:288,frames:124,steps:20,seed:42,includeAudio:true}},'生成视频');
  } else {
  await operation('executors/language/enable');
  const language=await until(()=>api('/language/models'),rows=>rows.some(m=>m.executor==='worker'&&m.ready));
  const lang=language.find(m=>m.executor==='worker'&&m.ready);
  await page.goto('http://127.0.0.1:5412');
  await run('text','text',{languageSelection:{profileId:lang.profileId,targetWorkerId:''}},'生成文本','用中文写一句不超过30字的清晨森林描写，只输出正文。');
  await operation('executors/language/disable',{policy:'wait'});
  await operation('runtimes/comfy-main/start');await operation('executors/image/enable');
  const images=await until(()=>api('/image-models'),rows=>rows.some(m=>m.id==='qwen-image-2512'&&m.ready));
  const image=images.find(m=>m.id==='qwen-image-2512').profiles[0];
  const imageDraft={operation:'image.generate.v1',modelId:image.modelId,profileId:image.profileId,prompt:'',negative:'',refs:[],format:'png',sizeMode:'custom',width:512,height:512,steps:'5',seed:'42'};
  const picture=await run('image','image',{generationDraft:imageDraft},'提交生成','A blue ceramic cup on a wooden table, soft daylight.');
  const editProfile=images.find(m=>m.id==='qwen-image-2.1')?.profiles[0];assert.ok(editProfile,'Qwen 2.1 required');
  const editDraft={...imageDraft,modelId:editProfile.modelId,profileId:editProfile.profileId,operation:'image.edit.v1',refs:[picture.id]};
  const lastPicture=await run('image-edit','image',{generationDraft:editDraft},'提交生成','Change the blue cup to a yellow cup. Keep the composition and lighting.');
  await run('image-reference','image',{generationDraft:{...editDraft,operation:'image.reference.v1',refs:[picture.id,lastPicture.id]}},'提交生成','Place the blue cup and the yellow cup side by side on the same wooden table.');
  await operation('runtimes/comfy-main/stop');await operation('executors/speech/enable');
  const speeches=await until(()=>api('/speech-models'),rows=>rows.some(m=>m.ready)),speech=speeches.find(m=>m.ready).profiles[0];
  const voice=await upload(process.env.ZHILUME_AUDIO_FILE);
  const speechDraft={modelId:'indextts-2.5',profileId:speech.profileId,text:'清晨的阳光穿过树林，新的一天开始了。',language:'ZH',speed:1,speaker:{assetId:voice.id,start:0,end:2},emotionReference:{assetId:'',start:0,end:2},emotionMode:'follow',emotionAlpha:.6,emotionText:'',emotionVector:Array(8).fill(0)};
  const sound=await run('speech','audio',{speechDraft},'合成语音');
  await operation('executors/speech/disable',{policy:'wait'});
  await operation('runtimes/comfy-main/start');await operation('executors/video/enable');
  const videos=await until(()=>api('/video-models'),rows=>rows.filter(m=>m.ready).length>=2);
  let clip;
  const modes=process.env.ZHILUME_VIDEO_MODES?.split(',')||['text','first','last','first-last','reference'];
  for(const mode of modes){
    const modelId=mode==='reference'?'minimax-h3-ref2va':'minimax-h3-fl2va',profile=videos.find(m=>m.id===modelId).profiles[0];
    const videoDraft={modelId,profileId:profile.profileId,mode,prompt:mode==='reference'?'Follow the visual style of <Picture 1>, the motion of <Video 1> and the voice of <Audio 1>. A cup on a wooden table.':'A ceramic cup on a wooden table slowly changes from blue to yellow. Fixed camera. Gentle room ambience.',firstFrameId:picture.id,lastFrameId:lastPicture.id,references:mode==='reference'?[{role:'image',assetId:picture.id,start:0,frames:56},...(clip?[{role:'video',assetId:clip.id,start:0,frames:56}]:[]),{role:'audio',assetId:sound.id,start:0,frames:56}]:[],width:512,height:288,frames:124,steps:20,seed:42,includeAudio:mode==='text'||mode==='reference'};
    clip=await run('video-'+mode,'video',{videoDraft},'生成视频');
  }
  }
  evidence.passed=true;
} catch(error) {
  evidence.error=error.message;
  if(page){await page.screenshot({path:join(root,'failure.png')}).catch(()=>{});evidence.visibleError=await page.locator('body').innerText().catch(()=>'');}
  process.exitCode=1;console.error(error);
} finally {
  if(currentJob)await api('/jobs/'+currentJob.id+'/cancel',{}).catch(()=>{});
  for(const executor of ['language','speech'])await operation('executors/'+executor+'/disable',{policy:'wait'}).catch(e=>{evidence.cleanupError=e.message;process.exitCode=1;});
  await operation('runtimes/comfy-main/stop').catch(e=>{evidence.cleanupError=e.message;process.exitCode=1;});
  if(browser)await browser.close();
  if(vite&&vite.exitCode===null){if(process.platform==='win32')await once(spawn('taskkill',['/PID',String(vite.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}),'exit');else vite.kill();}
  await app.close();evidence.finishedAt=new Date().toISOString();await writeFile(join(root,'result.json'),JSON.stringify(evidence,null,2));
}
