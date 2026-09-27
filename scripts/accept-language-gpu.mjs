// Explicit real GPU acceptance; credentials only arrive via the operator environment.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createApp } from '../dist/server.js';
if (!process.argv.includes('--execute')) throw Error('Real GPU acceptance requires --execute');
const root = resolve(process.env.ZHILUME_ACCEPTANCE_DIR);
await mkdir(root, { recursive: true });
const token = randomUUID(), app = await createApp({ root: resolve(process.env.ZHILUME_SERVER_DATA), token, tickMs: 100 });
const address = process.env.ZHILUME_WORKER_ADDRESS, admin = process.env.ZHILUME_MANAGEMENT_TOKEN;
const evidence = { startedAt: new Date().toISOString(), serverListening: app.server.listening, results: [], operations: [], samples: [] };
const jobs = [], delay = ms => new Promise(r => setTimeout(r, ms));
async function api(path, payload, method = payload ? 'POST' : 'GET') {
  const r = await app.inject({ method, url: '/api/v1' + path, headers: { authorization: 'Bearer ' + token }, payload });
  assert.ok(r.statusCode < 300, r.body); return r.json();
}
async function manage(path, payload, method = payload ? 'POST' : 'GET') {
  const r = await fetch(address + '/management/api/' + path, { method, headers: { authorization: 'Bearer ' + admin, 'content-type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(15000) });
  assert.ok(r.ok, 'Management HTTP ' + r.status); return r.json();
}
async function until(get, predicate, seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) { const v = await get(); if (predicate(v)) return v; await delay(300); }
  throw Error('Acceptance timed out');
}
async function operation(path, body = {}) {
  const start = Date.now(), { operationId } = await manage(path, body);
  const rows = await until(() => manage('operations'), v => v.some(x => x.id === operationId && x.state !== 'running'), 300);
  const o = rows.find(x => x.id === operationId);
  evidence.operations.push({ path, state: o.state, error: o.error, elapsedMs: Date.now() - start });
  assert.equal(o.state, 'succeeded', JSON.stringify(o));
}
async function settle(job, expected = 'succeeded') {
  let stage = '';
  const j = await until(async () => {
    const v = await api('/jobs/' + job.id), next = JSON.stringify([v.status, v.stage]);
    if (next !== stage) { console.log(job.operation, next); stage = next; }
    return v;
  }, v => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(v.status), 600);
  assert.equal(j.status, expected, JSON.stringify({ status: j.status, error: j.error }));
  const o = await until(() => manage('overview'), v => !v.tasks.length, 90);
  assert.equal(o.resourceQuarantined, false);
  assert.ok(o.gpus.length && o.gpus.every(g => +g.usedMiB < 1024));
  let output;
  if (j.status === 'succeeded') {
    const a = await api('/assets/' + j.outputAssetId);
    const r = await app.inject({ method: 'GET', url: '/api/v1/assets/' + a.id + '/content', headers: { authorization: 'Bearer ' + token } });
    assert.equal(r.statusCode, 200); assert.equal(createHash('sha256').update(r.rawPayload).digest('hex'), a.sha256);
    if (j.operation.startsWith('text.') || j.operation.startsWith('prompt.')) { assert.ok(j.outputText?.trim()); assert.equal(r.rawPayload.toString('utf8'), j.outputText); }
    output = { kind: a.kind, size: a.size, sha256: a.sha256, text: j.outputText };
  }
  evidence.results.push({ operation: job.operation, status: j.status, profileId: j.input.profileId, output, gpus: o.gpus });
  console.log('SETTLED', job.operation, j.status, o.gpus.map(g => g.usedMiB)); return j;
}
let monitoring = true;
const monitor = (async () => { while (monitoring) {
  const start = Date.now();
  try { const o = await manage('overview'); evidence.samples.push({ elapsedMs: Date.now() - start, active: o.tasks.length, usedMiB: o.gpus.map(g => +g.usedMiB) }); }
  catch (e) { evidence.samples.push({ error: e.message }); }
  await delay(1000);
} })();
try {
  const initial = await manage('overview'); assert.equal(initial.version, process.env.ZHILUME_EXPECTED_WORKER_VERSION || '0.12.0');
  assert.ok(!initial.tasks.length); evidence.workerVersion = initial.version; evidence.initialGpus = initial.gpus;
  await operation('executors/language/enable');
  const workers = await api('/workers'), worker = workers.find(w => w.id === initial.workerId);
  assert.ok(worker, 'Use the dedicated Server fixture previously bound to this Worker');
  await api('/workers/' + worker.id, { address, credential: process.env.ZHILUME_WORKER_TOKEN, disabled: false, draining: false }, 'PATCH');
  const models = await until(() => api('/language/models'), rows => rows.some(m => m.executor === 'worker' && m.ready));
  const profile = models.find(m => m.executor === 'worker' && m.ready); evidence.profile = profile;
  const project = await api('/projects', { name: '真实语言模型 GPU 验收' });
  async function submit(operation, input, requestId = randomUUID()) {
    const body = { requestId, projectId: project.id, operation, input }, j = await api('/jobs', body);
    assert.equal((await api('/jobs', body)).id, j.id); jobs.push(j); return j;
  }
  const input = text => ({ profileId: profile.profileId, text });
  const text = await settle(await submit('text.generate.v1', input('用中文写一句不超过30字的清晨森林描写，只输出结果。')));
  assert.match(text.outputText, /[\u4e00-\u9fff]/);
  if (!process.argv.includes('--smoke-only')) {
  await settle(await submit('prompt.optimize.v1', { ...input('蓝色玻璃杯放在木桌上，保持蓝色，不增加文字。'), purpose: 'qwen', context: { operation: 'image.generate.v1' } }));
  await settle(await submit('prompt.optimize.v1', { ...input('A blue cup slowly rotates on a wooden table. Fixed camera. No music.'), purpose: 'h3', context: { mode: 'text', duration: 5, includeAudio: false } }));
  const cancel = await submit('text.generate.v1', input('请逐条详细讲解一百种电影镜头语言，每条至少五十字。'));
  await until(() => api('/jobs/' + cancel.id), j => j.status === 'running' && String(j.stage).includes('生成文本'), 180);
  const held = await manage('overview'); assert.ok(held.gpus.some(g => +g.usedMiB > 2048));
  const queued = await submit('text.generate.v1', input('只用中文回复：取消后已恢复。'));
  assert.equal((await api('/jobs/' + queued.id)).status, 'queued');
  const start = Date.now(); await api('/jobs/' + cancel.id + '/cancel', {});
  // The queued job may immediately take the lease; observe terminal cancellation separately.
  await until(() => api('/jobs/' + cancel.id), j => j.status === 'cancelled', 60);
  evidence.cancelMs = Date.now() - start;
  evidence.results.push({ operation: cancel.operation, status: 'cancelled', queuedFollower: true });
  await settle(queued);
  if (!process.argv.includes('--language-only')) {
    await operation('executors/language/disable', { policy: 'wait' });
    await operation('runtimes/comfy-main/start'); await operation('executors/image/enable');
    const available = await until(() => api('/models'), m => m.image.some(x => x.id === 'qwen-image-2512' && x.ready));
    const p = available.image.find(x => x.id === 'qwen-image-2512').profiles[0];
    await settle(await submit('image.generate.v1', { profileId: p.profileId, modelId: p.modelId, workflowRevision: p.workflowRevision, prompt: 'A blue ceramic cup on a wooden table.', negativePrompt: '', referenceAssetIds: [], width: 512, height: 512, steps: 5, seed: 27, outputFormat: 'png' }));
    await operation('runtimes/comfy-main/stop', { policy: 'wait' });
    await operation('executors/language/enable');
    await settle(await submit('text.generate.v1', input('只用中文回复：图片执行器切换后已恢复。')));
  }
  }
  await operation('executors/language/disable', { policy: 'wait' });
  assert.ok(evidence.samples.some(s => s.active > 0)); assert.ok(evidence.samples.every(s => !s.error));
  evidence.passed = true;
} catch (e) { evidence.error = e.message; throw e; }
finally {
  for (const j of jobs) { try { const s = await api('/jobs/' + j.id); if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(s.status)) await api('/jobs/' + j.id + '/cancel', {}); } catch {} }
  monitoring = false; await monitor; evidence.finishedAt = new Date().toISOString();
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2)); await app.close();
  console.log('LANGUAGE_GPU_ACCEPTANCE', evidence.passed ? 'PASSED' : 'FAILED');
}
