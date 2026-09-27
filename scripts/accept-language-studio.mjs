// Uses a previously configured private Server data directory. One real API call.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/server.js';
import { chromium, expect } from '../../zhilume-studio/node_modules/@playwright/test/index.mjs';
if (!process.argv.includes('--execute')) throw Error('Live API acceptance requires --execute');
const root=resolve('.data/language-development'), out=resolve('artifacts/language-studio');
await mkdir(out,{recursive:true});const token=randomUUID();
const app=await createApp({root,token,tickMs:100});
const api=async(path,payload,method=payload?'POST':'GET')=>{const r=await app.inject({method,url:'/api/v1'+path,headers:{authorization:'Bearer '+token},payload});assert.ok(r.statusCode<300);return r.json();};
let browser,vite,log;
const evidence={fixtureResponses:false,gpuInference:false,passed:false};
try {
  const project=await api('/projects',{name:'DeepSeek 界面验收 '+Date.now()});
  await api(`/projects/${project.id}/canvas`,{schemaVersion:1,baseRevision:0,viewport:{x:0,y:0,zoom:1},nodes:[{id:'image',type:'media',position:{x:500,y:100},data:{kind:'image',title:'提示词优化',generationDraft:{operation:'image.generate.v1',modelId:'qwen-image-2512',profileId:'',prompt:'蓝色玻璃杯放在木桌上，保持杯子蓝色，不增加文字。',negative:'',sizeMode:'ratio',steps:'',seed:'',refs:[],format:'png',width:1024,height:1024}}}],edges:[]},'PUT');
  await app.listen({host:'127.0.0.1',port:0});const base='http://127.0.0.1:'+app.server.address().port;
  log=openSync(join(out,'vite.log'),'w');vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5414','--strictPort'],{cwd:resolve('../zhilume-studio'),env:{...process.env,ZHILUME_DEV_SERVER:base},windowsHide:true,stdio:['ignore',log,log]});
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:5414')).ok)break;}catch{}await new Promise(r=>setTimeout(r,300));}
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
  evidence.pageErrors=[];page.on('pageerror',e=>evidence.pageErrors.push(e.message));
  await page.addInitScript(t=>sessionStorage.setItem('zhilume.session',t),token);await page.goto('http://127.0.0.1:5414');
  await page.getByText(project.name,{exact:true}).click();await page.locator('.react-flow__node[data-id="image"]').click();
  const panel=page.getByRole('region',{name:'图片生成与编辑'}),prompt=panel.getByLabel('提示词',{exact:true});const original=await prompt.inputValue();
  await panel.getByRole('button',{name:'优化提示词',exact:true}).click();
  const suggestion=panel.getByLabel('建议稿');await expect(suggestion).not.toHaveValue('',{timeout:120000});
  await expect(prompt).toHaveValue(original);evidence.originalPreservedBeforeApply=true;
  const proposed=await suggestion.inputValue();assert.ok(/[\u4e00-\u9fff]/.test(proposed),'Expected original Chinese language');
  await page.screenshot({path:join(out,'suggestion.png')});
  await panel.getByRole('button',{name:'应用建议'}).click();await expect(prompt).toHaveValue(proposed);evidence.explicitApply=true;
  evidence.result=proposed;evidence.passed=true;
} finally {
  await browser?.close();
  if(vite && vite.exitCode===null){const exited=once(vite,'exit');if(process.platform==='win32'){const p=spawn('taskkill',['/PID',String(vite.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await once(p,'exit');}else vite.kill();await exited;}
  if(log!==undefined)closeSync(log);await app.close();await writeFile(join(out,'result.json'),JSON.stringify(evidence,null,2)+'\n');
}
console.log(JSON.stringify(evidence));
