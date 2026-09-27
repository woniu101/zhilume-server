// Explicit live, potentially billable API acceptance. No key is emitted or persisted outside the Server vault.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createApp } from '../dist/server.js';
if (!process.argv.includes('--execute')) throw Error('Pass --execute to perform live API requests');
const root=resolve(process.env.ZHILUME_ACCEPT_DATA || '.data/language-development');
const reportPath=resolve(process.env.ZHILUME_ACCEPT_REPORT || 'artifacts/language-api-result.json');
const raw=await readFile(process.env.ZHILUME_API_KEY_FILE,'utf8');
const keys=raw.match(/sk-[A-Za-z0-9_-]+/g);assert.equal(keys?.length,1,'Expected exactly one API key');
const apiKey=keys[0], token=randomBytes(24).toString('base64url');
const available=await fetch('https://api.deepseek.com/models',{headers:{authorization:'Bearer '+apiKey},signal:AbortSignal.timeout(30000)});
assert.equal(available.status,200,'Model listing failed');
const metadata=(await available.json()).data.find(m=>m.id==='deepseek-flash');assert.ok(metadata,'Selected exact model unavailable');
const app=await createApp({root,token,tickMs:100});
const report={date:new Date().toISOString(),provider:'DeepSeek',model:metadata.id,displayName:metadata.name,cases:[],passed:false};
const call=async(path,payload)=>{const r=await app.inject({method:payload?'POST':'GET',url:'/api/v1'+path,headers:{authorization:'Bearer '+token},payload});assert.ok(r.statusCode<300,`Local API ${path}: ${r.statusCode}`);return r.json();};
try {
  const existing=(await call('/language/providers')).find(p=>p.name==='DeepSeek');
  const provider=await call('/language/providers',{id:existing?.id,name:'DeepSeek',baseUrl:'https://api.deepseek.com',apiKey,
    models:[{model:metadata.id,name:metadata.name,revision:metadata.name,capabilities:['text','structured'],maxImages:0,structuredMode:'json_object',reasoningEffort:'none',maxOutputTokens:1024}],
    defaults:{text:metadata.id,general:metadata.id,qwen:metadata.id,h3:metadata.id}});
  assert.ok(!JSON.stringify(provider).includes(apiKey));
  const profileId=provider.models[0].profileId;
  const project=await call('/projects',{name:'语言模型真实 API 验收'});
  for(const c of [
    {name:'文本生成',operation:'text.generate.v1',text:'请用一句中文描述清晨森林，不超过40字。'},
    {name:'Qwen 提示词建议',operation:'prompt.optimize.v1',purpose:'qwen',text:'一只蓝色玻璃杯放在木桌上，保持杯子蓝色，不增加文字。'},
    {name:'JSON 对象与 Schema 校验',operation:'text.generate.v1',text:'请返回JSON对象，title为清晨森林，count为3。',schema:{type:'object',properties:{title:{type:'string'},count:{const:3}},required:['title','count'],additionalProperties:false}},
    {name:'H3 规则建议',operation:'prompt.optimize.v1',purpose:'h3',text:'蓝色玻璃杯在木桌上缓慢旋转，镜头固定。',context:{mode:'text',duration:5,includeAudio:false}},
  ]) {
    const body={requestId:crypto.randomUUID(),projectId:project.id,operation:c.operation,input:{...c,profileId}};
    const start=Date.now(), job=await call('/jobs',body);assert.equal((await call('/jobs',body)).id,job.id);
    let result;
    for(let i=0;i<250;i++){result=await call('/jobs/'+job.id);if(['succeeded','failed','cancelled'].includes(result.status))break;await new Promise(r=>setTimeout(r,600));}
    assert.ok(!JSON.stringify(result).includes(apiKey));
    report.cases.push({name:c.name,status:result.status,executor:result.executor,archived:!!result.outputAssetId,originalPreserved:result.input.text===c.text,result:result.outputText,error:result.error,elapsedMs:Date.now()-start});
    assert.equal(result.status,'succeeded',result.error || 'Task failed');assert.equal(result.input.text,c.text);assert.ok(result.outputAssetId);
    process.stdout.write(c.name+' passed\n');
  }
  const stored=await readFile(join(root,'language-vault.enc'));assert.ok(!stored.includes(Buffer.from(apiKey)));
  report.passed=true;
} finally {
  await app.close();await mkdir(resolve(reportPath,'..'),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
}
