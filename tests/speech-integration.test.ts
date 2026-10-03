import { createResultNode, assertNodeResult } from './result-helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { createApp } from '../src/server.js';
import { startWorker, stopWorker } from './worker-helper.js';

test('speech real transport and owned runner: reference roles, WAV archive, failure and cancellation', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'zhilume-speech-test-'));
  const app = await createApp({ root: join(root, 'server'), token: 'speech-test-only', tickMs: 50 });
  let peer: Awaited<ReturnType<typeof startWorker>> | undefined;
  t.after(async () => {
    await stopWorker(peer?.child); await app.close();
    if (resolve(root).startsWith(resolve(tmpdir()) + sep + 'zhilume-speech-test-')) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const upstream = join(root, 'fixture-upstream');
  await mkdir(join(upstream, 'indextts/utils'), { recursive: true });
  for (const name of ['indextts/__init__.py', 'indextts/utils/__init__.py', 'indextts/utils/model_download.py']) await writeFile(join(upstream, name), '');
  await writeFile(join(upstream, 'torch.py'), 'class cuda:\n    @staticmethod\n    def is_available(): return True\n');
  await writeFile(join(upstream, 'indextts/infer_v2_5.py'), `import json, wave, time, os
from pathlib import Path
class IndexTTS2:
    def __init__(self, **kwargs): pass
    def infer(self, **kwargs):
        Path('received.json').write_text(json.dumps(kwargs), 'utf-8')
        if kwargs['text'] == 'failure': raise RuntimeError('fixture failure')
        if kwargs['text'] == 'hold': time.sleep(30)
        with wave.open(kwargs['output_path'], 'wb') as out:
            out.setparams((1, 2, 24000, 24000, 'NONE', 'not compressed'))
            out.writeframes(bytes(48000))
`);
  const configPath = join(root, 'speech.json');
  const python = process.env.ZHILUME_TEST_PYTHON || resolve('../zhilume-worker/.venv/' + (process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  await writeFile(configPath, JSON.stringify({ identity: { revision: 'fixture-v1', quantization: 'fp32', artifacts: { tts: 'revision:fixture-v1' } }, python, repository: upstream, modelDirectory: upstream, ffmpeg, enableEmotionText: false }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const headers = { Authorization: 'Bearer speech-test-only' };
  const call = async (path: string, payload?: any) => {
    const res = await app.inject({ method: payload ? 'POST' : 'GET', url: '/api/v1' + path, headers, payload });
    assert.ok(res.statusCode < 300, res.body); return res.json();
  };
  async function wait(get: () => Promise<any>, ready: (v: any) => boolean) {
    for (let i = 0; i < 200; i++) { const value = await get(); if (ready(value)) return value; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('timeout: ' + peer?.log() + await peer?.diagnostics());
  }
  peer = await startWorker(join(root, 'worker'), ['--speech-config', configPath, '--enable-speech-execution'], undefined, false, resolve('../zhilume-worker/tests/speech_worker.py'));
  await call('/workers', { address: peer.address, credential: peer.credential });
  const models = await wait(() => call('/speech-models'), v => v[0].ready);
  const p = models[0].profiles[0];
  const project = await call('/projects', { name: 'CPU fixture speech transport' });
  await createResultNode(app,headers,project.id,'audio');
  const uploaded = await app.inject({ method: 'POST', url: '/api/v1/assets/uploads?filename=voice.wav', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, payload: await readFile('tests/fixtures/interaction-test.wav') });
  assert.equal(uploaded.statusCode, 201);
  const asset = uploaded.json();
  const request = (text: string) => ({ requestId: crypto.randomUUID(), projectId: project.id, nodeId: 'result-target', operation: 'audio.speech.v1', input: {
    modelId: p.modelId, profileId: p.profileId, workflowRevision: p.workflowRevision, text, language: 'ZH', speed: 1.25,
    speaker: { assetId: asset.id, start: 0, end: 1.5 }, emotionMode: 'reference', emotionAlpha: .5,
    emotionReference: { assetId: asset.id, start: .5, end: 2 }, emotionVector: Array(8).fill(0), emotionText: '' } });
  const body = request('正常测试'), job = await call('/jobs', body);
  assert.equal((await call('/jobs', body)).id, job.id);
  const done = await wait(() => call('/jobs/' + job.id), j => ['failed', 'succeeded'].includes(j.status));
  assert.equal(done.status, 'succeeded', JSON.stringify(done));
  await assertNodeResult(app,headers,project.id,done,'audio');
  const output = await call('/assets/' + done.outputAssetId);
  assert.equal(output.kind, 'audio'); assert.match(output.filename, /\.wav$/);
  assert.deepEqual(output.provenance.sourceAssetIds, [asset.id]);
  assert.equal(output.provenance.parameters.speed, 1.25);
  const received = JSON.parse(await readFile(join(upstream, 'received.json'), 'utf8'));
  assert.equal(received.duration_factor, .8);
  assert.notEqual(received.spk_audio_prompt, received.emo_audio_prompt);
  const failed = await call('/jobs', request('failure'));
  const error = await wait(() => call('/jobs/' + failed.id), j => j.status === 'failed');
  assert.match(error.error, /speech.log/); assert.ok(!error.outputAssetId);
  const held = await call('/jobs', request('hold'));
  await wait(async () => JSON.parse(await readFile(join(upstream, 'received.json'), 'utf8')), v => v.text === 'hold');
  await call('/jobs/' + held.id + '/cancel', {});
  const cancelled = await wait(() => call('/jobs/' + held.id), j => j.status === 'cancelled');
  assert.ok(!cancelled.outputAssetId);
  const next = await call('/jobs', request('取消后仍可运行'));
  const nextDone = await wait(() => call('/jobs/' + next.id), j => ['failed', 'succeeded'].includes(j.status));
  assert.equal(nextDone.status, 'succeeded', JSON.stringify(nextDone));
});
