// Prepare isolated packaged apps for manual native UI acceptance; never drives native controls.
import assert from 'node:assert/strict';
import {mkdir,copyFile,readFile,writeFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {_electron} from '../../zhilume-studio/node_modules/@playwright/test/index.mjs';
assert.ok(process.argv.includes('--execute'),'--execute required: enables GPU models for native acceptance');
const root=resolve(process.env.ZHILUME_ACCEPTANCE_DIR),data=join(root,'server-data'),token=randomUUID();
await mkdir(data,{recursive:true});await copyFile(join(process.env.ZHILUME_SERVER_DATA,'worker-connections.json'),join(data,'worker-connections.json'));
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const base='http://127.0.0.1:'+port,headers={Authorization:'Bearer '+token};
let desktop,project;
const server=spawn(resolve('release/win-unpacked/Zhilume Server.exe'),[resolve('release/win-unpacked/resources/app.asar/dist/main.js')],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',ZHILUME_PORT:String(port),ZHILUME_DATA:data,ZHILUME_TOKEN:token},stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,payload,method=payload?'POST':'GET') {const r=await fetch(base+'/api/v1'+path,{method,headers:{...headers,'Content-Type':'application/json'},body:payload?JSON.stringify(payload):undefined});assert.ok(r.ok,await r.clone().text());return r.json();}
async function until(get,predicate,seconds=180){const end=Date.now()+seconds*1000;while(Date.now()<end){const v=await get();if(predicate(v))return v;await delay(500);}throw Error('Native acceptance timed out');}
async function manage(path,payload){const r=await fetch(process.env.ZHILUME_WORKER_ADDRESS+'/management/api/'+path,{method:payload?'POST':'GET',headers:{Authorization:'Bearer '+process.env.ZHILUME_MANAGEMENT_TOKEN,'Content-Type':'application/json'},body:payload?JSON.stringify(payload):undefined});assert.ok(r.ok,'management '+r.status);return r.json();}
async function operation(path,payload={}){console.log('OPERATION',path);const {operationId}=await manage(path,payload);const rows=await until(()=>manage('operations'),rows=>rows.some(o=>o.id===operationId&&o.state!=='running'),300);assert.equal(rows.find(o=>o.id===operationId).state,'succeeded');}
try{
  await until(async()=>{try{return await api('/system');}catch{return null;}},Boolean,60);
  const overview=await manage('overview');assert.equal(overview.tasks.length,0);
  await api('/workers',{address:process.env.ZHILUME_WORKER_ADDRESS,credential:process.env.ZHILUME_WORKER_TOKEN});
  await operation('runtimes/comfy-main/start');for(const id of ['language','image','video','speech'])await operation('executors/'+id+'/enable');
  const models=await until(()=>api('/models'),m=>m.language.some(x=>x.executor==='worker'&&x.ready)&&m.image.some(x=>x.ready)&&m.video.some(x=>x.ready)&&m.speech.some(x=>x.ready));
  const language=models.language.find(x=>x.executor==='worker'&&x.ready),image=models.image.find(x=>x.id==='qwen-image-2512').profiles[0],video=models.video.find(x=>x.id==='minimax-h3-fl2va').profiles[0],speech=models.speech.find(x=>x.ready).profiles[0];
  const upload=await fetch(base+'/api/v1/assets/uploads?filename=voice.wav',{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:await readFile(process.env.ZHILUME_AUDIO_FILE)});assert.ok(upload.ok);const voice=await upload.json();
  const drafts=[{textDraft:'用中文写一句不超过20字的森林描写，只输出正文。',languageSelection:{profileId:language.profileId,targetWorkerId:''}},
    {generationDraft:{operation:'image.generate.v1',modelId:image.modelId,profileId:image.profileId,prompt:'A yellow ceramic cup on a wooden table, soft daylight.',negative:'',refs:[],format:'png',sizeMode:'custom',width:512,height:512,steps:'5',seed:'43'}},
    {videoDraft:{modelId:video.modelId,profileId:video.profileId,mode:'text',prompt:'A ceramic cup on a wooden table. Slow camera pan. Quiet room ambience.',firstFrameId:'',lastFrameId:'',references:[],width:512,height:288,frames:124,steps:20,seed:43,includeAudio:true}},
    {speechDraft:{modelId:'indextts-2.5',profileId:speech.profileId,text:'清晨的阳光穿过树林，新的一天开始了。',language:'ZH',speed:1,speaker:{assetId:voice.id,start:0,end:2},emotionReference:{assetId:'',start:0,end:2},emotionMode:'follow',emotionAlpha:.6,emotionText:'',emotionVector:Array(8).fill(0)}}];
  project=await api('/projects',{name:'0.20 原生四类真实生成验收'});
  await api(`/projects/${project.id}/canvas`,{schemaVersion:1,baseRevision:0,viewport:{x:0,y:0,zoom:1},nodes:['text','image','video','audio'].map((kind,i)=>({id:kind,type:'media',position:{x:120+i%2*350,y:120+Math.floor(i/2)*240},style:{width:280,height:176},data:{kind,title:['文本验收','图片验收','视频验收','语音验收'][i],...drafts[i]}})),edges:[]},'PUT');
  const session=await api('/session',{token}),profile={base,...session,name:'0.20 原生验收'};
  desktop=await _electron.launch({executablePath:resolve('../zhilume-studio/release/win-unpacked/Zhilume Studio.exe'),env:{...process.env,ZHILUME_USER_DATA:join(root,'studio')},timeout:30000});
  const page=await desktop.firstWindow();await page.waitForFunction(()=>!!window.zhilumeDesktop);
  await page.evaluate(value=>window.zhilumeDesktop.writeSession(value),{...profile,profiles:[profile]});await page.reload();
  await writeFile(join(root,'native.json'),JSON.stringify({root,base,projectId:project.id,studioVersion:'0.20.0',serverVersion:'0.15.0'},null,2));
  console.log('NATIVE_READY',root);
  await until(async()=>{try{await access(join(root,'finish-native'));return true;}catch{return false;}},Boolean,1800);
  const jobs=await api(`/jobs?projectId=${project.id}`),canvas=await api(`/projects/${project.id}/canvas`),results=await api(`/projects/${project.id}/node-results`);
  assert.equal(jobs.length,4);assert.ok(jobs.every(j=>j.status==='succeeded'));assert.equal(results.length,4);
  assert.ok(canvas.nodes.every(n=>n.data.assetId));
  await writeFile(join(root,'result.json'),JSON.stringify({passed:true,client:'Windows packaged Studio and Server',jobs:jobs.map(j=>({id:j.id,nodeId:j.nodeId,operation:j.operation,status:j.status})),canvasSaved:true,results:results.length},null,2));
}finally{
  if(project){for(const j of await api(`/jobs?projectId=${project.id}`).catch(()=>[]))if(!['succeeded','failed','cancelled','interrupted'].includes(j.status))await api('/jobs/'+j.id+'/cancel',{}).catch(()=>{});}
  for(const id of ['language','speech'])await operation('executors/'+id+'/disable',{policy:'wait'}).catch(e=>console.error(e.message));
  await operation('runtimes/comfy-main/stop').catch(e=>console.error(e.message));
  if(desktop)await desktop.close().catch(()=>{});server.kill();
}
