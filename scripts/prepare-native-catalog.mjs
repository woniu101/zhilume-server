// Isolated CPU-only fixture. Native controls are operated separately with Computer Use.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,access,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createApp} from '../dist/server.js';
import {_electron} from '../../zhilume-studio/node_modules/@playwright/test/index.mjs';
assert.ok(process.env.ZHILUME_ACCEPTANCE_DIR,'Use an isolated acceptance directory');
const root=resolve(process.env.ZHILUME_ACCEPTANCE_DIR),data=join(root,'server-data'),token=randomUUID();
await mkdir(root,{recursive:true});
const fixture=await createApp({root:data,token}),headers={authorization:'Bearer '+token};
const req=async(method,path,payload,extra={})=>{const r=await fixture.inject({method,url:'/api/v1'+path,headers:{...headers,...extra},payload});assert.ok(r.statusCode<300,r.body);return r.json();};
const project=await req('POST','/projects',{name:'0.22 原生素材验收'}),assets=[];
for(const [name,file] of [['竖版图片.png','portrait.png'],['参考音色.wav','interaction-test.wav'],['参考视频.mp4','interaction-test.mp4']]){
  const asset=await req('POST','/assets/uploads?filename='+encodeURIComponent(name),await readFile(resolve('../zhilume-studio/e2e/fixtures',file)),{'content-type':'application/octet-stream'});
  assets.push(asset);await req('POST',`/projects/${project.id}/library`,{assetId:asset.id});
}
const original=fixture.store.get('asset',assets[0].id);
fixture.store.atomic(()=>{for(let i=0;i<10000;i++)fixture.store.put('asset',{...original,id:randomUUID(),filename:`检索样本-${String(i).padStart(5,'0')}.png`});});
await req('PUT',`/projects/${project.id}/canvas`,{schemaVersion:1,baseRevision:0,viewport:{x:0,y:0,zoom:1},nodes:[
  ...['image','audio','video','text'].map((kind,i)=>({id:kind,type:'media',position:{x:60+i%3*340,y:70+Math.floor(i/3)*390},style:{width:280,height:176},data:{kind,title:{image:'图片验收',audio:'语音验收',video:'视频验收',text:'文本验收'}[kind]}})),
  {id:'portrait',type:'media',position:{x:420,y:460},style:{width:280,height:176},data:{kind:'image',title:'尺寸避让验收',assetId:assets[0].id}},
  {id:'neighbor',type:'media',position:{x:420,y:660},style:{width:280,height:176},data:{kind:'text',title:'避让下方节点'}}],edges:[]});
await fixture.close();
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const base='http://127.0.0.1:'+port;
const server=spawn(resolve('release/win-unpacked/Zhilume Server.exe'),[resolve('release/win-unpacked/resources/app.asar/dist/main.js')],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',ZHILUME_PORT:String(port),ZHILUME_DATA:data,ZHILUME_TOKEN:token},stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const exists=async path=>{try{await access(path);return true;}catch{return false;}};
async function api(path,payload){const r=await fetch(base+'/api/v1'+path,{method:payload?'POST':'GET',headers:{...headers,'Content-Type':'application/json'},body:payload?JSON.stringify(payload):undefined});assert.ok(r.ok,await r.clone().text());return r.json();}
let desktop;
async function launch(){desktop=await _electron.launch({executablePath:resolve('../zhilume-studio/release/win-unpacked/Zhilume Studio.exe'),env:{...process.env,ZHILUME_USER_DATA:join(root,'studio')},timeout:30000});return desktop.firstWindow();}
try{
  for(let i=0;i<60;i++){try{await api('/system');break;}catch{await pause(500);}}
  const timings=[];for(let i=0;i<20;i++){const start=performance.now();const page=await api('/assets/query',{source:'service',q:'检索样本-099',kinds:['image']});assert.equal(page.items.length,24);timings.push(performance.now()-start);}
  const session=await api('/session',{token}),profile={base,...session,name:'0.22 验收服务'};
  const page=await launch();await page.waitForFunction(()=>!!window.zhilumeDesktop);await page.evaluate(value=>window.zhilumeDesktop.writeSession(value),{...profile,profiles:[profile]});await page.reload();
  await writeFile(join(root,'native.json'),JSON.stringify({base,projectId:project.id,assets:assets.map(a=>({id:a.id,filename:a.filename,metadata:a.metadata})),searchMs:timings.sort((a,b)=>a-b)},null,2));
  console.log('NATIVE_READY',root);
  const deadline=Date.now()+45*60*1000;
  while(Date.now()<deadline && !await exists(join(root,'finish-native'))){
    if(await exists(join(root,'reopen-native'))){await unlink(join(root,'reopen-native'));await desktop.close().catch(()=>{});await launch();console.log('NATIVE_REOPENED');}
    if(await exists(join(root,'measure-native'))){await unlink(join(root,'measure-native'));await writeFile(join(root,'memory.json'),JSON.stringify(await desktop.evaluate(({app})=>app.getAppMetrics().map(m=>({type:m.type,memory:m.memory}))),null,2));}
    await pause(500);
  }
  await writeFile(join(root,'canvas-final.json'),JSON.stringify(await api(`/projects/${project.id}/canvas`),null,2));
}finally{if(desktop)await desktop.close().catch(()=>{});server.kill();}
