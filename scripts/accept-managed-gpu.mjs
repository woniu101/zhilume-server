// Operator-only real GPU acceptance. Never includes credentials in evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createApp } from '../dist/server.js';
if (!process.argv.includes('--execute')) throw Error('Real GPU test requires --execute');
const root = resolve(process.env.ZHILUME_ACCEPTANCE_DIR);
await mkdir(root, { recursive: true });
const address = process.env.ZHILUME_WORKER_ADDRESS, admin = process.env.ZHILUME_MANAGEMENT_TOKEN;
const app = await createApp({ root: resolve(process.env.ZHILUME_SERVER_DATA), token: 'local-managed-fixture', tickMs: 200 });
const evidence = { startedAt: new Date().toISOString(), serverListening: app.server.listening, results: [], operations: [], managementSamples: [] };
const submitted = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function api(path, body) {
  const r = await app.inject({ method: body ? 'POST' : 'GET', url: '/api/v1' + path, headers: { Authorization: 'Bearer local-managed-fixture' }, payload: body });
  assert.ok(r.statusCode < 300, r.body); return r.json();
}
async function manage(path, body, method = body ? 'POST' : 'GET') {
  const start = Date.now();
  const r = await fetch(address + '/management/api/' + path, { method, headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  assert.ok(r.ok, 'management status ' + r.status + ': ' + await r.clone().text());
  const data = await r.json();
  if (path === 'overview') evidence.managementSamples.push({ at: new Date().toISOString(), elapsedMs: Date.now() - start, active: data.tasks.length });
  return data;
}
async function until(get, test, seconds = 300, label = 'condition') {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { const v = await get(); if (test(v)) return v; await delay(1500); }
  throw Error('Timed out: ' + label);
}
async function operation(path, body = {}, method) {
  console.log('OPERATION', path);
  const start = Date.now(), { operationId } = await manage(path, body, method);
  const rows = await until(() => manage('operations'), rows => rows.some(o => o.id === operationId && o.state !== 'running'), 240, path);
  const op = rows.find(o => o.id === operationId);
  evidence.operations.push({ path, state: op.state, elapsedMs: Date.now() - start, result: op.result, error: op.error });
  assert.equal(op.state, 'succeeded', JSON.stringify(op));
  return op.result;
}
async function settled(job, expected = 'succeeded') {
  let previous = '';
  const final = await until(async () => {
    const j = await api('/jobs/' + job.id);
    const stage = JSON.stringify([j.status, j.stage, j.progress]);
    if (stage !== previous) { console.log(job.operation, stage); previous = stage; }
    return j;
  }, j => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.status), 1800, job.operation);
  assert.equal(final.status, expected, JSON.stringify({ status: final.status, error: final.error }));
  const overview = await until(() => manage('overview'), o => !o.tasks.length, 180, 'GPU release');
  assert.equal(overview.resourceQuarantined, false);
  assert.ok(overview.gpus.every(g => Number(g.usedMiB) < 1536), 'Physical GPU occupancy has not returned to idle');
  let output = null;
  if (final.status === 'succeeded') {
    const asset = await api('/assets/' + final.outputAssetId);
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/' + asset.id + '/content', headers: { Authorization: 'Bearer local-managed-fixture' } });
    assert.equal(response.statusCode, 200);
    assert.equal(createHash('sha256').update(response.rawPayload).digest('hex'), asset.sha256);
    output = { id: asset.id, size: asset.size, sha256: asset.sha256, kind: asset.kind };
    await mkdir(join(root, 'outputs'), { recursive: true });
    await writeFile(join(root, 'outputs', job.id + '.' + ({ image: 'png', video: 'mp4', audio: 'wav' }[asset.kind])), response.rawPayload);
  }
  evidence.results.push({ operation: job.operation, status: final.status, jobId: job.id, profileId: final.input.profileId, output, gpus: overview.gpus });
  console.log('SETTLED', job.operation, final.status, overview.gpus.map(g => g.usedMiB));
  return final;
}
let monitoring = true;
const monitor = (async () => {
  while (monitoring) {
    try { await manage('overview'); } catch (e) { evidence.managementSamples.push({ at: new Date().toISOString(), error: e.message, cause: e.cause?.code || e.cause?.message }); }
    await delay(4000);
  }
})();
try {
  const initial = await manage('overview');
  assert.equal(initial.version, process.env.ZHILUME_EXPECTED_WORKER_VERSION || '0.10.0');
  evidence.workerVersion = initial.version;
  evidence.workerId = initial.workerId;
  evidence.initialGpus = initial.gpus;
  await operation('runtimes/comfy-main/check');
  await operation('runtimes/comfy-main/start');
  for (const kind of ['image', 'video', 'speech']) await operation('executors/' + kind + '/enable');
  const all = await api('/workers');
  if (!all.length) await api('/workers', { address, credential: process.env.ZHILUME_WORKER_TOKEN });
  else {
    assert.equal(all.length, 1, 'Acceptance requires a dedicated Server fixture');
    const update = await app.inject({ method: 'PATCH', url: '/api/v1/workers/' + all[0].id, headers: { Authorization: 'Bearer local-managed-fixture' }, payload: { address, credential: process.env.ZHILUME_WORKER_TOKEN, disabled: false, draining: false } });
    assert.ok(update.statusCode < 300, update.body);
  }
  const models = await until(() => api('/models'), m => m.image.some(x => x.id === 'qwen-image-2512' && x.ready) && m.video.some(x => x.id === 'minimax-h3-fl2va' && x.ready) && m.speech.some(x => x.ready), 120, 'model readiness');
  const image = models.image.find(x => x.id === 'qwen-image-2512').profiles[0], video = models.video.find(x => x.id === 'minimax-h3-fl2va').profiles[0], speech = models.speech.find(x => x.ready).profiles[0];
  evidence.profiles = { image: image.profileId, video: video.profileId, speech: speech.profileId };
  const project = await api('/projects', { name: '托管运行环境 GPU 验收' });
  async function submit(operation, input) {
    const j = await api('/jobs', { requestId: crypto.randomUUID(), projectId: project.id, operation, input });
    submitted.push(j); return j;
  }
  const imageInput = { modelId: image.modelId, profileId: image.profileId, workflowRevision: image.workflowRevision, prompt: 'A small blue ceramic cup on a wooden table, soft daylight.', negativePrompt: '', referenceAssetIds: [], width: 512, height: 512, steps: 5, seed: 27, outputFormat: 'png' };
  const videoInput = { modelId: video.modelId, profileId: video.profileId, workflowRevision: video.workflowRevision, mode: 'text', prompt: 'A small blue sphere slowly rotates on a wooden table in warm daylight. Static camera. Gentle room ambience.', width: 512, height: 288, frames: 124, steps: 20, seed: 42, includeAudio: true, references: [] };
  if (!process.argv.includes('--lifecycle-only')) {
    const firstImage = await settled(await submit('image.generate.v1', imageInput));
    if (process.argv.includes('--image-variants')) {
      const edit = models.image.find(x => x.id === 'qwen-image-2.1' && x.ready)?.profiles[0];
      assert.ok(edit, 'Qwen Image 2.1 must be explicitly configured for image variant acceptance');
      const editInput = { ...imageInput, modelId: edit.modelId, profileId: edit.profileId, workflowRevision: edit.workflowRevision };
      const secondImage = await settled(await submit('image.generate.v1', { ...editInput, prompt: 'A small red ceramic teapot on a wooden table, soft daylight.' }));
      const { width, height, ...referenceInput } = editInput;
      await settled(await submit('image.edit.v1', { ...referenceInput, prompt: 'Change the blue cup to yellow. Keep its shape, table and lighting unchanged.', referenceAssetIds: [firstImage.outputAssetId] }));
      await settled(await submit('image.reference.v1', { ...referenceInput, prompt: 'Place the blue cup from image 1 beside the red teapot from image 2 on the same wooden table. Keep both objects fully visible.', referenceAssetIds: [firstImage.outputAssetId, secondImage.outputAssetId] }));
    }
    const bytes = await readFile(process.env.ZHILUME_AUDIO_FILE);
    const upload = await app.inject({ method: 'POST', url: '/api/v1/assets/uploads?filename=speaker.wav', headers: { Authorization: 'Bearer local-managed-fixture', 'Content-Type': 'application/octet-stream' }, payload: bytes });
    assert.ok(upload.statusCode < 300, upload.body);
    await settled(await submit('audio.speech.v1', { modelId: speech.modelId, profileId: speech.profileId, workflowRevision: speech.workflowRevision, text: '这是织镜的托管执行器切换测试。', language: 'ZH', speed: 1, speaker: { assetId: upload.json().id, start: 0, end: 2 }, emotionMode: 'follow', emotionAlpha: .6, emotionVector: Array(8).fill(0), emotionText: '', emotionReference: { assetId: '', start: 0, end: 2 } }));
    await settled(await submit('video.generate.v1', videoInput));
  }
  const cancel = await submit('video.generate.v1', { ...videoInput, steps: 50 });
  await until(() => api('/jobs/' + cancel.id), j => j.status === 'running' && String(j.stage).includes('模型执行中'), 240, 'video inference started');
  await delay(10000);
  // Stop the shared backend while the second consumer (video) owns the GPU.
  await operation('runtimes/comfy-main/stop', { policy: 'cancel' });
  await settled(cancel, 'cancelled');
  const stopped = await manage('overview');
  assert.equal(stopped.runtimes.find(r => r.id === 'comfy-main').state, 'stopped');
  assert.ok(stopped.executors.filter(e => ['image', 'video'].includes(e.id)).every(e => !e.enabled && e.state === 'disabled'));
  evidence.stoppedGpus = stopped.gpus;
  await operation('runtimes/comfy-main/start');
  await operation('executors/image/enable');
  await settled(await submit('image.generate.v1', { ...imageInput, seed: 28 }));
  await operation('runtimes/comfy-main/stop', { policy: 'wait' });
  assert.ok(evidence.managementSamples.some(s => s.active > 0), 'No management samples during inference');
  assert.ok(evidence.managementSamples.every(s => !s.error), 'Management probe failed during acceptance');
  evidence.passed = true;
} catch (error) {
  evidence.error = error.message;
  throw error;
} finally {
  for (const job of submitted) {
    try { const j = await api('/jobs/' + job.id); if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.status)) await api('/jobs/' + job.id + '/cancel', {}); } catch {}
  }
  monitoring = false; await monitor;
  evidence.finishedAt = new Date().toISOString();
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2));
  await app.close();
  console.log('MANAGED_GPU_ACCEPTANCE', evidence.passed === true ? 'PASSED' : 'FAILED');
}
