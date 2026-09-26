import { createApp } from '../dist/server.js';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
if (!process.argv.includes('--execute')) { console.error('此验收会执行真实 GPU 任务，需要 --execute'); process.exit(2); }
const root = resolve(process.env.ZHILUME_ACCEPTANCE_DIR || 'artifacts/cloud-acceptance');
const token = randomUUID();
const options = { root: join(root, 'server-data'), token, tickMs: 500 };
let app = await createApp(options);
async function call(path, body) {
  const response = await app.inject({ method: body ? 'POST' : 'GET', url: '/api/v1' + path, headers: { Authorization: 'Bearer ' + token }, payload: body });
  assert.ok(response.statusCode < 300, response.body); return response.json();
}
async function wait(get, ready) {
  for (let i=0; i<180; i++) { const v=await get(); if (ready(v)) return v; await new Promise(r=>setTimeout(r,1000)); }
  throw Error('timeout');
}
try {
  const config = JSON.parse(await readFile(join(root, 'server-data/worker-connections.json'), 'utf8'));
  const address = Object.values(config.workers)[0]?.address;
  assert.ok(address, '先运行 accept-cloud.mjs 完成测试 Worker 接入');
  assert.equal((await fetch(address + '/api/v1/system')).status, 401, 'public Worker rejects unauthenticated access');
  const models=await wait(()=>call('/image-models'),m=>m.every(m=>m.ready));
  assert.equal(app.server.listening,false);
  const model=models.find(m=>m.id==='qwen-image-2.1'), p=model.profiles[0];
  const project=await call('/projects',{name:'Cloud result outbox and no inbound Server'});
  const job=await call('/jobs',{requestId:randomUUID(),projectId:project.id,operation:'image.generate.v1',input:{modelId:model.id,profileId:p.profileId,workflowRevision:p.workflowRevision,prompt:'A yellow ceramic teapot on a light wooden table, clean product photography.',negativePrompt:'',referenceAssetIds:[],width:512,height:512,steps:25,seed:42,outputFormat:'png'}});
  const active=await wait(()=>call('/jobs/'+job.id),j=>j.stage?.includes('模型执行中'));
  console.log('Accepted GPU task; close Server for 12 seconds:',job.id);
  await app.close();
  await new Promise(r=>setTimeout(r,12000));
  app=await createApp(options);
  const done=await wait(()=>call('/jobs/'+job.id),j=>['succeeded','failed','interrupted'].includes(j.status));
  assert.equal(done.status,'succeeded',JSON.stringify(done));
  assert.equal(done.attemptId,active.attemptId,'no duplicate inference after reconnect');
  assert.equal(app.server.listening,false);
  await writeFile(join(root,'reconnect-result.json'),JSON.stringify({status:done.status,jobId:done.id,attemptId:done.attemptId,serverHadNoListeningPort:true,disconnectSeconds:12,unauthenticatedStatus:401},null,2));
  console.log('PASS: Server without listening port reconnects and archives original attempt.');
} finally { await app.close(); }
