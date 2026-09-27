// Explicit real-GPU acceptance. Credentials are supplied only via environment.
import { createApp } from '../dist/server.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const mode = process.argv[2];
if (!['follow', 'fast', 'slow', 'vector', 'text', 'reference', 'cancel', 'after-cancel'].includes(mode) || !process.argv.includes('--execute')) {
  console.error('Usage: node scripts/accept-speech-cloud.mjs <mode> --execute (uses real GPU)');
  process.exit(2);
}
for (const key of ['ZHILUME_WORKER_ADDRESS', 'ZHILUME_WORKER_TOKEN', 'ZHILUME_SPEAKER_FILE']) assert.ok(process.env[key], key + ' is required');
const root = resolve(process.env.ZHILUME_ACCEPTANCE_DIR || 'artifacts/speech-acceptance');
await mkdir(join(root, 'outputs'), { recursive: true });
const token = randomUUID();
const app = await createApp({ root: join(root, 'server-data'), token, tickMs: 500 });
const headers = { Authorization: 'Bearer ' + token };
// inject deliberately never listens: the remote Worker cannot call this Server.
async function call(path, payload) {
  const res = await app.inject({ method: payload ? 'POST' : 'GET', url: '/api/v1' + path, headers, payload });
  assert.ok(res.statusCode < 300, res.body); return res.json();
}
async function wait(get, ready, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const value = await get();
    if (ready(value)) return value;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw Error('Acceptance timed out');
}
async function upload(filename) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/assets/uploads?filename=reference.wav',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' }, payload: await readFile(filename) });
  assert.equal(res.statusCode, 201, res.body); return res.json();
}
let job;
try {
  if (!(await call('/workers')).length) await call('/workers', { address: process.env.ZHILUME_WORKER_ADDRESS, credential: process.env.ZHILUME_WORKER_TOKEN });
  const models = await wait(() => call('/speech-models'), m => m.some(v => v.id === 'indextts-2.5' && v.ready));
  const profile = models.find(m => m.id === 'indextts-2.5').profiles[0];
  const project = await call('/projects', { name: '上海二 A IndexTTS 真实验收 ' + mode });
  const speaker = await upload(process.env.ZHILUME_SPEAKER_FILE);
  const emotion = mode === 'reference' ? await upload(process.env.ZHILUME_EMOTION_FILE || process.env.ZHILUME_SPEAKER_FILE) : null;
  const input = { modelId: profile.modelId, profileId: profile.profileId, workflowRevision: profile.workflowRevision,
    text: mode === 'cancel' ? '这是一次取消测试，任务停止后应该释放显存，随后仍然可以继续生成新的语音。'.repeat(10) : '你好，欢迎使用织镜。今天我们一起，把脑海中的灵感变成作品。',
    language: 'ZH', speed: mode === 'fast' ? 1.5 : mode === 'slow' ? .75 : 1,
    speaker: { assetId: speaker.id, start: 0, end: 5 },
    emotionMode: ['vector', 'text', 'reference'].includes(mode) ? mode : 'follow', emotionAlpha: .6,
    emotionVector: [.6, 0, 0, 0, 0, 0, 0, 0], emotionText: '开心、温暖、充满期待',
    ...(emotion ? { emotionReference: { assetId: emotion.id, start: 1, end: 5 } } : {}) };
  const body = { requestId: randomUUID(), projectId: project.id, operation: 'audio.speech.v1', input };
  const started = Date.now();
  job = await call('/jobs', body);
  assert.equal((await call('/jobs', body)).id, job.id, 'Duplicate request must not launch twice');
  console.log(JSON.stringify({ mode, jobId: job.id, started: new Date().toISOString() }));
  if (mode === 'cancel') {
    await wait(() => call('/jobs/' + job.id), j => {
      if (j.status === 'failed') throw Error(j.error);
      return j.stage?.includes('加载 IndexTTS');
    });
    await new Promise(r => setTimeout(r, Number(process.env.ZHILUME_CANCEL_DELAY_MS || 20000)));
    await call('/jobs/' + job.id + '/cancel', {});
  }
  let last;
  const done = await wait(() => call('/jobs/' + job.id), j => {
    const state = j.status + ':' + j.stage;
    if (state !== last) { console.log(state); last = state; }
    return ['succeeded', 'failed', 'cancelled'].includes(j.status);
  }, 960);
  const record = { mode, elapsedSeconds: (Date.now() - started) / 1000, profile, job: done, serverListened: false };
  if (done.status === 'succeeded') {
    const asset = await call('/assets/' + done.outputAssetId);
    const response = await app.inject({ method: 'GET', url: '/api/v1/assets/' + asset.id + '/content', headers });
    assert.equal(response.statusCode, 200);
    const bytes = response.rawPayload;
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
    assert.equal(asset.kind, 'audio');
    assert.deepEqual(asset.provenance.sourceAssetIds, [...new Set([speaker.id, ...(emotion ? [emotion.id] : [])])]);
    assert.equal(asset.provenance.parameters.speed, input.speed);
    record.asset = asset; record.output = join(root, 'outputs', mode + '.wav');
    await writeFile(record.output, bytes);
  }
  await writeFile(join(root, mode + '-result.json'), JSON.stringify(record, (k, v) => ['url', 'downloadUrl'].includes(k) ? undefined : v, 2));
  console.log(JSON.stringify({ mode, status: done.status, elapsedSeconds: record.elapsedSeconds, error: done.error }));
  assert.equal(done.status, mode === 'cancel' ? 'cancelled' : 'succeeded');
} catch (error) {
  // Bound unexpected script failure rather than leaving paid work orphaned.
  if (job) await call('/jobs/' + job.id + '/cancel', {}).catch(() => {});
  throw error;
} finally {
  await app.close();
}
