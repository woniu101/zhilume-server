import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../src/server.js';

test('real CPU worker exports media, validates ranges and persists lineage; image models remain unavailable', { timeout: 60000 }, async t => {
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
    if (worker && worker.exitCode === null) { const exited = once(worker, 'exit'); worker.kill(); await exited; }
    await app.close();
    if (resolve(root).startsWith(resolve(tmpdir()) + sep + 'zhilume-media-test-')) await rm(root, { recursive: true, force: true });
  });
  const source = join(root, 'source.mp4');
  execFileSync(process.env.ZHILUME_FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=128x72:r=10:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source], { windowsHide: true });
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
  const enrollment = await call('/enrollments', {});
  worker = spawn(process.env.ZHILUME_TEST_PYTHON || resolve('../zhilume-worker/.venv/' + (process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')),
    ['-m', 'zhilume_worker', '--server', `http://127.0.0.1:${port}`, '--state', join(root, 'worker'), '--enrollment', enrollment.token],
    { cwd: resolve('../zhilume-worker'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = ''; worker.stderr?.on('data', b => { log = (log + b).slice(-2000); });
  async function wait(get: () => Promise<any>, ready: (v: any) => boolean) {
    for (let i = 0; i < 200; i++) { const value = await get(); if (ready(value)) return value; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('CPU worker timeout: ' + log);
  }
  await wait(() => call('/capabilities'), list => list.some((c: any) => c.id === 'media.audio.extract.v1' && c.ready));
  for (const operation of ['media.video.trim.v1', 'media.audio.extract.v1']) {
    const job = await call('/jobs', jobRequest(operation, .5, 1.5));
    assert.equal(job.simulation, false);
    const done = await wait(() => call('/jobs/' + job.id), j => ['succeeded', 'failed'].includes(j.status));
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
    const result = await call('/assets/' + done.outputAssetId);
    assert.equal(result.kind, operation.includes('audio') ? 'audio' : 'video');
    assert.deepEqual(result.provenance, { operation, sourceAssetIds: [asset.id], parameters: { start: .5, end: 1.5 } });
    assert.notEqual(result.sha256, asset.sha256);
  }
  const badProvenance = await app.inject({ method: 'POST', url: '/api/v1/assets/uploads?filename=crop.png', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Asset-Provenance': '{"operation":"image.crop.v1","sourceAssetIds":["missing"],"parameters":{}}' }, payload: Buffer.from([137,80,78,71,13,10,26,10]) });
  assert.equal(badProvenance.statusCode, 404);
});
