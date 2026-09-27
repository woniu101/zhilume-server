import { createRequire } from "node:module";
const ffmpeg = createRequire(import.meta.url)("ffmpeg-static");
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../src/server.js';

test('Server bundled FFmpeg exports without Workers and persists lineage', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'zhilume-media-test-'));
  const app = await createApp({ root: join(root, 'server'), token: 'cpu-test-only', tickMs: 50 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as any).port;
  const headers = { Authorization: 'Bearer cpu-test-only' };
  const call = async (path: string, body?: any) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method: body ? 'POST' : 'GET', headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(res.ok, true, await res.clone().text()); return res.json();
  };
  let worker: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    await stopWorker(worker);
    await app.close();
    if (resolve(root).startsWith(resolve(tmpdir()) + sep + 'zhilume-media-test-')) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const source = join(root, 'source.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=128x72:r=10:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source], { windowsHide: true });
  const project = await call('/projects', { name: 'CPU 验收' });
  const uploaded = await app.inject({ method: 'POST', url: '/api/v1/assets/uploads?filename=source.mp4', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, payload: await readFile(source) });
  assert.equal(uploaded.statusCode, 201);
  const asset = uploaded.json();
  const jobRequest = (operation: string, start: number, end: number) => ({ requestId: crypto.randomUUID(), projectId: project.id, operation, input: { assetId: asset.id, start, end } });
  const invalid = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers, payload: jobRequest('media.video.trim.v1', 2, 1) });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, 'invalid_range');
  const models = await call('/image-models');
  assert.deepEqual(models[0].operations, ['image.generate.v1']);
  assert.ok(models.every((m: any) => m.status === 'awaiting_gpu_validation'));
  const log = '';
  async function wait(get: () => Promise<any>, ready: (v: any) => boolean) {
    for (let i = 0; i < 200; i++) { const value = await get(); if (ready(value)) return value; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('CPU worker timeout: ' + log);
  }
  await wait(() => call('/capabilities'), list => list.some((c: any) => c.id === 'media.audio.extract.v1' && c.ready));
  for (const operation of ['media.video.trim.v1', 'media.audio.extract.v1']) {
    const job = await call('/jobs', jobRequest(operation, .5, 1.5));
    assert.equal(job.simulation, false);
    assert.equal(job.executor, "server");
    assert.equal(job.workerId, null);
    const done = await wait(() => call('/jobs/' + job.id), j => ['succeeded', 'failed'].includes(j.status));
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
    const result = await call('/assets/' + done.outputAssetId);
    assert.equal(result.kind, operation.includes('audio') ? 'audio' : 'video');
    assert.deepEqual(result.provenance, { operation, sourceAssetIds: [asset.id], parameters: { start: .5, end: 1.5 } });
    assert.notEqual(result.sha256, asset.sha256);
  }
  assert.deepEqual(await call('/workers'), []);
  const outOfRange = await call('/jobs', jobRequest('media.video.trim.v1', 0, 5));
  const invalidRange = await wait(() => call('/jobs/' + outOfRange.id), j => j.status === 'failed');
  assert.equal(invalidRange.errorCode, 'invalid_range');
  const badProvenance = await app.inject({ method: 'POST', url: '/api/v1/assets/uploads?filename=crop.png', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Asset-Provenance': '{"operation":"image.crop.v1","sourceAssetIds":["missing"],"parameters":{}}' }, payload: Buffer.from([137,80,78,71,13,10,26,10]) });
  assert.equal(badProvenance.statusCode, 404);
});

test('Server serial queue cancels, stays responsive, restarts and retries independently of Workers', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'zhilume-queue-test-'));
  let app = await createApp({ root: join(root, 'server'), token: 'queue-test', tickMs: 50 });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const headers = { Authorization: 'Bearer queue-test' };
  const call = async (url: string, payload?: any) => {
    const res = await app.inject({ method: payload ? 'POST' : 'GET', url: '/api/v1' + url, headers, ...(payload ? { payload } : {}) });
    assert.ok(res.statusCode < 300, res.body); return res.json();
  };
  const wait = async (id: string, status: string) => {
    for (let i = 0; i < 300; i++) { const j = await call('/jobs/' + id); if (j.status === status) return j; await new Promise(r => setTimeout(r, 20)); }
    throw Error('Timeout waiting for ' + status);
  };
  const source = join(root, 'source.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=1920x1080:r=30:d=12', '-c:v', 'libx264', '-preset', 'ultrafast', source], { windowsHide: true });
  const upload = await app.inject({ method: 'POST', url: '/api/v1/assets/uploads?filename=source.mp4', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Media-Sync-Id': '11111111-1111-4111-8111-111111111111' }, payload: await readFile(source) });
  const repeated = await app.inject({ method: 'POST', url: '/api/v1/assets/uploads?filename=source.mp4', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Media-Sync-Id': '11111111-1111-4111-8111-111111111111' }, payload: await readFile(source) });
  assert.equal(repeated.json().id, upload.json().id);
  const project = await call('/projects', { name: 'Queue' });
  const submit = () => call('/jobs', { requestId: crypto.randomUUID(), projectId: project.id, operation: 'media.video.trim.v1', input: { assetId: upload.json().id, start: 0, end: 12 } });
  const first = await submit(), second = await submit();
  assert.equal((await call('/jobs/' + first.id)).status, 'running');
  assert.equal((await call('/jobs/' + second.id)).status, 'queued');
  assert.ok((await call('/projects')).some((p: any) => p.id === project.id));
  await call('/jobs/' + second.id + '/cancel', {}); assert.equal((await call('/jobs/' + second.id)).status, 'cancelled');
  await call('/jobs/' + first.id + '/cancel', {}); await wait(first.id, 'cancelled');
  const interrupted = await submit(); await wait(interrupted.id, 'running');
  await app.close();
  app = await createApp({ root: join(root, 'server'), token: 'queue-test', tickMs: 50 });
  assert.equal((await call('/jobs/' + interrupted.id)).status, 'interrupted');
  await call('/jobs/' + interrupted.id + '/retry', {});
  const done = await wait(interrupted.id, 'succeeded'); assert.ok(done.outputAssetId); assert.equal(done.attempts.length, 1);
});
import { stopWorker } from './worker-helper.js';
