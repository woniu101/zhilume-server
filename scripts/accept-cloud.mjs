import { createApp } from '../dist/server.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const mode = process.argv[2];
const allowed = ['2512', '2512-large', '21', '21-large', 'edit', 'refs', 'refs4', 'rgba', 'cancel'];
if (!allowed.includes(mode) || !process.argv.includes('--execute')) {
  console.error('用法：node scripts/accept-cloud.mjs <模式> --execute。会在已连接的真实 Worker 执行任务；GPU 模式会使用显卡资源。');
  process.exit(2);
}
const root = resolve(process.env.ZHILUME_ACCEPTANCE_DIR || 'artifacts/cloud-acceptance');
const token = randomUUID();
const app = await createApp({ root: join(root, 'server-data'), token, tickMs: 500 });
const headers = { Authorization: 'Bearer ' + token };
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
async function call(path, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw Error(JSON.stringify(value));
  return value;
}
async function waitFor(get, ready, seconds = 90) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const value = await get();
    if (ready(value)) return value;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw Error('Timed out');
}
await mkdir(join(root, 'outputs'), { recursive: true });
let job;
try {
  const address = process.env.ZHILUME_WORKER_ADDRESS;
  const workers = await call('/workers');
  if (!workers.length) await call('/workers', { address: address, credential: process.env.ZHILUME_WORKER_TOKEN });
  const models = await waitFor(() => call('/image-models'), list => list.some(m => m.id === (mode.startsWith('2512') ? 'qwen-image-2512' : 'qwen-image-2.1') && m.ready));
  console.log('Cloud Worker connected; mode:', mode);
  const project = await call('/projects', { name: '上海二A 5090 真实验收 ' + mode });
  let operation, input;
  {
    const model = models.find(m => m.id === (mode.startsWith('2512') ? 'qwen-image-2512' : 'qwen-image-2.1'));
    const p = model.profiles[0];
    const references = [];
    if (['edit','refs','refs4'].includes(mode)) {
      for (const name of mode === 'edit' ? ['21'] : mode === 'refs4' ? ['21','2512','edit','rgba'] : ['21','2512']) {
        const previous = JSON.parse(await readFile(join(root, name + '-result.json'), 'utf8'));
        references.push(previous.asset.id);
      }
    }
    operation = mode === 'edit' ? 'image.edit.v1' : mode.startsWith('refs') ? 'image.reference.v1' : 'image.generate.v1';
    const prompt = mode === 'edit' ? 'Change the blue ceramic teapot to bright red. Keep the teapot shape, wooden table, composition and lighting unchanged.'
      : mode === 'refs4' ? 'Create a product display on a wooden table using all four references: the blue teapot from image 1 on the left, the mint green robot from image 2 in the center, the red teapot from image 3 on the right, and the blue teapot from image 4 in the foreground. Four separate objects, all fully visible.'
      : mode === 'refs' ? 'Place the blue ceramic teapot from image 1 beside the small mint green toy robot from image 2 on the same light wooden table. Both objects fully visible, natural daylight, clean product photograph.'
      : mode.startsWith('2512') ? 'A small mint green toy robot on a light wooden table, soft window light, clean product photography, centered full view, plain warm gray background.'
      : mode === 'rgba' ? 'A single blue ceramic teapot, isolated on a transparent background, clean product cutout, no table, no shadow, full object.'
      : 'A blue ceramic teapot on a light wooden table, soft window light, clean product photography, centered full view, plain warm gray background.';
    const size = mode === 'cancel' || mode === '21-large' ? 1536 : mode === '2512-large' ? 1024 : 512;
    input = { modelId: model.id, profileId: p.profileId, workflowRevision: p.workflowRevision, prompt, negativePrompt: '', seed: 20260926, steps: mode === 'cancel' ? 100 : mode === '2512-large' ? 50 : mode === '2512' ? 30 : 25, outputFormat: mode === 'rgba' ? 'rgba' : 'png', referenceAssetIds: references, ...(operation === 'image.generate.v1' ? { width: size, height: size } : {}) };
  }
  const started = Date.now();
  job = await call('/jobs', { requestId: randomUUID(), projectId: project.id, operation, input });
  console.log(JSON.stringify({ mode, jobId: job.id, started: new Date().toISOString() }));
  if (mode === 'cancel') {
    await waitFor(() => call('/jobs/' + job.id), j => j.stage?.includes('模型执行中'));
    await new Promise(r => setTimeout(r, 4000));
    console.log('Request cancellation after Comfy acknowledged execution');
    await call('/jobs/' + job.id + '/cancel', {});
  }
  let last = '';
  const done = await waitFor(() => call('/jobs/' + job.id), j => {
    const status = `${j.status}:${j.progress}`;
    if (status !== last) { console.log(status); last = status; }
    return ['succeeded','failed','cancelled'].includes(j.status);
  }, 1800);
  const record = { mode, elapsedSeconds: (Date.now()-started)/1000, job: done };
  if (done.status === 'succeeded') {
    const asset = await call('/assets/' + done.outputAssetId);
    const response = await fetch(base + '/assets/' + asset.id + '/content', { headers });
    assert.ok(response.ok); const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
    const path = join(root, 'outputs', mode + '.png');
    await writeFile(path, bytes); record.asset = asset; record.output = path;
  }
  await writeFile(join(root, mode + '-result.json'), JSON.stringify(record, (key, value) => ['url', 'downloadUrl'].includes(key) ? undefined : value, 2));
  console.log(JSON.stringify({ mode, status: done.status, elapsedSeconds: record.elapsedSeconds, error: done.error, output: record.output }));
  if (done.status !== (mode === 'cancel' ? 'cancelled' : 'succeeded')) process.exitCode = 1;
} finally {
  await app.close();
}
