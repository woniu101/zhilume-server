import { createResultNode, assertNodeResult } from './result-helper.js';
import { fingerprint } from '../src/execution.js';
function signed(p: any) { const { profileId, ...spec } = p; spec.identity ||= { revision: 'fixture-v1', quantization: 'fp32', artifacts: { model: 'revision:fixture-v1' } }; return { ...spec, profileId: fingerprint(spec) }; }
import { startWorker, stopWorker } from "./worker-helper.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from '../src/server.js';
import { imageModels, validateImageInput, validateImageProfiles, supportsImageJob } from '../src/image-operations.js';

test('profile validation, scheduling isolation, reference count and dimensions', () => {
  const model = imageModels[1];
  const profile = signed({ modelId: model.id, profileId: 'a'.repeat(64), workflowRevision: model.workflowRevision, operations: model.operations,
    maxReferences: 4, formats: model.formats, minSize: 256, maxSize: 1536, sizeStep: 32, referenceResolution: 1024, defaultSteps: 25, maxSteps: 100, validation: 'unverified' });
  assert.equal(validateImageProfiles([profile]).length, 1);
  assert.equal(validateImageProfiles([signed({ ...profile, maxReferences: 10 })]).length, 1);
  assert.throws(() => validateImageProfiles([{ ...profile, maxReferences: 11 }]));
  assert.throws(() => validateImageProfiles([{ ...profile, validation: 'verified' }]));
  const w = { connected: true, lastHeartbeat: Date.now(), imageProfiles: [profile] };
  const input = { modelId: model.id, profileId: profile.profileId, workflowRevision: model.workflowRevision, prompt: '绘制', negativePrompt: '', referenceAssetIds: ['a', 'b'], steps: 25, seed: 0, outputFormat: 'png' };
  const lookup = () => ({ kind: 'image', size: 42 });
  const validated = validateImageInput('image.reference.v1', input, [w], lookup);
  assert.deepEqual(validated.referenceAssetIds, ['a', 'b']);
  assert.equal(validated.referenceResolution, 1024);
  assert.throws(() => validateImageInput('image.reference.v1', { ...input, width: 1024 }, [w], lookup));
  assert.throws(() => validateImageInput('image.edit.v1', input, [w], lookup));
  assert.doesNotThrow(() => validateImageInput('image.reference.v1', input, [{ ...w, connected: false }], lookup));
  assert.equal(supportsImageJob(w, { operation: 'image.reference.v1', input }), true);
  assert.equal(supportsImageJob(w, { operation: 'image.reference.v1', input: { ...input, profileId: 'b'.repeat(64) } }), false);
});

test('real Python worker against local fake Comfy: text generation, ordered multi-reference, provenance and cancellation', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'zhilume-image-test-'));
  const app = await createApp({ root: join(root, 'server'), token: 'image-test-only', tickMs: 50 });
  const config = JSON.parse(await readFile('../zhilume-worker/config/comfy.example.json', 'utf8'));
  config.profiles.forEach((p: any) => { p.identity = { revision: 'fixture-v1', quantization: 'fp32', artifacts: Object.fromEntries(Object.keys(p.models).map(k => [k, 'revision:fixture-v1-'+k])) }; });
  const info: any = Object.fromEntries(imageModels.flatMap(m => m.requiredNodes).map(n => [n, {}]));
  for (const [node, field, key] of [['UNETLoader', 'unet_name', 'diffusion'], ['CLIPLoader', 'clip_name', 'clip'], ['VAELoader', 'vae_name', 'vae']])
    info[node] = { input: { required: { [field]: [config.profiles.map((p: any) => p.models[key])] } } };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2kAAAAASUVORK5CYII=', 'base64');
  const graphs: any[] = [], uploads: Buffer[] = [], interrupted: string[] = [];
  let active: string | null = null, hold = false, refuseInterrupt = false;
  const comfy = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks), path = new URL(req.url!, 'http://local').pathname;
      const body = req.headers['content-type']?.includes('application/json') ? JSON.parse(raw.toString()) : undefined;
      let result: any;
      if (path === '/system_stats') result = { devices: [] };
      else if (path === '/object_info') result = info;
      else if (path === '/queue') result = { queue_pending: [], queue_running: active ? [[0, active]] : [] };
      else if (path === '/upload/image') { uploads.push(raw); result = { name: `reference-${uploads.length}.png`, subfolder: '' }; }
      else if (path === '/prompt') { graphs.push(body); active = body.prompt_id; result = { prompt_id: active }; }
      else if (path.startsWith('/history/')) {
        result = hold ? {} : { [path.split('/').pop()!]: { status: { completed: true }, outputs: { output: { images: [{ filename: 'output.png', subfolder: '', type: 'output' }] } } } };
        if (!hold) active = null;
      } else if (path === '/view') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); return; }
      else if (path === '/interrupt') {
        if (refuseInterrupt) { res.writeHead(503); res.end(); return; }
        interrupted.push(body.prompt_id); assert.equal(body.prompt_id, active); active = null; result = {};
      }
      else { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(500); res.end(); }
  });
  let worker: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    await stopWorker(worker);
    await app.close(); await new Promise<void>(r => comfy.close(() => r()));
    if (resolve(root).startsWith(resolve(tmpdir()) + sep + 'zhilume-image-test-')) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  comfy.listen(0, '127.0.0.1'); await once(comfy, 'listening');
  config.url = `http://127.0.0.1:${(comfy.address() as any).port}`;
  const configPath = join(root, 'comfy.json'); await writeFile(configPath, JSON.stringify(config));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const headers = { Authorization: 'Bearer image-test-only' };
  const call = async (path: string, body?: any) => {
    const res = await app.inject({ method: body ? 'POST' : 'GET', url: '/api/v1' + path, headers, payload: body });
    assert.ok(res.statusCode < 300, res.body); return res.json();
  };
  let log = ''; let last: any;
  async function wait(get: () => Promise<any>, ready: (v: any) => boolean) {
    for (let i = 0; i < 250; i++) { const v = await get(); last=v; if (ready(v)) return v; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('Worker timed out: ' + JSON.stringify(last) + log);
  }
  const peer = await startWorker(join(root, 'worker'), ['--comfy-config', configPath, '--enable-image-execution']);
  worker = peer.child;
  await call('/workers', { address: peer.address, credential: peer.credential });
  const models = await wait(() => call('/image-models'), v => v.every((m: any) => m.ready));
  assert.equal(graphs.length, 0, 'readiness must never submit inference');
  const project = await call('/projects', { name: 'CPU-only fake Comfy acceptance' });
  await createResultNode(app,headers,project.id,'image');
  const assets = [];
  for (const name of ['first.png', 'second.png']) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/assets/uploads?filename=' + name, headers: { ...headers, 'Content-Type': 'application/octet-stream' }, payload: png });
    assert.equal(res.statusCode, 201); assets.push(res.json());
  }
  const request = (index: number, operation: string, refs: string[] = []) => {
    const model = models[index], p = model.profiles[0];
    return { requestId: crypto.randomUUID(), projectId: project.id, nodeId: 'result-target', operation, input: { modelId: model.id, profileId: p.profileId, workflowRevision: p.workflowRevision,
      prompt: '测试画面', negativePrompt: '', seed: 7, steps: 2, outputFormat: 'png', referenceAssetIds: refs, ...(operation === 'image.generate.v1' ? { width: 256, height: 256 } : {}) } };
  };
  for (const body of [request(0, 'image.generate.v1'), request(1, 'image.reference.v1', [assets[1].id, assets[0].id])]) {
    const job = await call('/jobs', body);
    assert.equal((await call('/jobs', body)).id, job.id);
    const done = await wait(() => call('/jobs/' + job.id), j => ['succeeded', 'failed'].includes(j.status));
    assert.equal(done.status, 'succeeded', JSON.stringify(done) + log);
    await assertNodeResult(app,headers,project.id,done,'image');
    const result = await call('/assets/' + done.outputAssetId);
    assert.equal(result.kind, 'image');
    assert.deepEqual(result.provenance.sourceAssetIds, body.input.referenceAssetIds);
    assert.equal(result.provenance.parameters.profileId, body.input.profileId);
    assert.equal(result.provenance.parameters.seed, 7);
  }
  assert.equal(graphs.length, 2);
  assert.equal(graphs[1].prompt.reference_1.inputs.image, 'reference-1.png');
  assert.equal(uploads.length, 2);
  hold = true;
  const job = await call('/jobs', request(1, 'image.generate.v1'));
  await wait(async () => active, v => !!v);
  await call('/jobs/' + job.id + '/cancel', {});
  const done = await wait(() => call('/jobs/' + job.id), j => ['cancelled', 'failed'].includes(j.status));
  assert.equal(done.status, 'cancelled', JSON.stringify(done));
  assert.equal(interrupted.length, 1);
  assert.equal(active, null);
  refuseInterrupt = true;
  const uncertain = await call('/jobs', request(1, 'image.generate.v1'));
  await wait(async () => active, v => !!v);
  await call('/jobs/' + uncertain.id + '/cancel', {});
  const failed = await wait(() => call('/jobs/' + uncertain.id), j => j.status === 'failed');
  assert.match(failed.error, /无法确认 GPU 任务停止/);
  await wait(() => call('/image-models'), list => list.every((m: any) => !m.ready));
  assert.ok(active, 'unknown stop must not be represented as cancelled');
});
