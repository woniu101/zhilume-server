// Explicit operator acceptance: real Studio UI -> Server -> GPU Worker -> canvas.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createApp } from '../dist/server.js';
import { chromium, expect } from '../../zhilume-studio/node_modules/@playwright/test/index.mjs';

if (!process.argv.includes('--execute')) throw Error('Real GPU acceptance requires --execute');
const root = resolve(process.env.ZHILUME_ACCEPTANCE_DIR);
await mkdir(root, { recursive: true });
const token = randomUUID(), address = process.env.ZHILUME_WORKER_ADDRESS;
const app = await createApp({ root: join(root, 'server-data'), token, tickMs: 200 });
const headers = { Authorization: 'Bearer ' + token };
const evidence = { startedAt: new Date().toISOString(), gpuInference: true, fixtureResponses: false };
let browser, page, vite, logFd, job;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function api(path, body, method = body ? 'POST' : 'GET') {
  const r = await app.inject({ method, url: '/api/v1' + path, headers, payload: body });
  assert.ok(r.statusCode < 300, r.body); return r.json();
}
async function until(get, ready, seconds = 180) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { const v = await get(); if (ready(v)) return v; await delay(1000); }
  throw Error('Acceptance condition timed out');
}
async function manage(path, body) {
  const r = await fetch(address + '/management/api/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + process.env.ZHILUME_MANAGEMENT_TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  assert.ok(r.ok, 'Management HTTP ' + r.status); return r.json();
}
async function operation(path) {
  const { operationId } = await manage(path, {});
  const rows = await until(() => manage('operations'), a => a.some(o => o.id === operationId && o.state !== 'running'));
  const op = rows.find(o => o.id === operationId); assert.equal(op.state, 'succeeded', op.error);
}
try {
  assert.equal((await manage('overview')).version, '0.11.0');
  await operation('runtimes/comfy-main/check');
  await operation('runtimes/comfy-main/start');
  await operation('executors/image/enable');
  const workers = await api('/workers');
  if (!workers.length) await api('/workers', { address, credential: process.env.ZHILUME_WORKER_TOKEN });
  else {
    assert.equal(workers.length, 1, 'Use a dedicated acceptance Server directory');
    await api('/workers/' + workers[0].id, { address, credential: process.env.ZHILUME_WORKER_TOKEN, disabled: false, draining: false }, 'PATCH');
  }
  const models = await until(() => api('/image-models'), a => a.some(m => m.id === 'qwen-image-2512' && m.ready));
  const profile = models.find(m => m.id === 'qwen-image-2512').profiles[0];
  const project = await api('/projects', { name: '全新环境 · Studio 实际生成 ' + Date.now() });
  await api('/projects/' + project.id + '/canvas', { schemaVersion: 1, baseRevision: 0, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'image', type: 'media', position: { x: 500, y: 180 }, style: { width: 280 }, data: { kind: 'image', title: '全新环境生成', generationDraft: { operation: 'image.generate.v1', modelId: profile.modelId, profileId: profile.profileId, prompt: '', negative: '', refs: [], format: 'png', sizeMode: 'ratio', width: 512, height: 512, steps: '5', seed: '27' } } }], edges: [] }, 'PUT');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  logFd = openSync(join(root, 'vite.log'), 'w');
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5412', '--strictPort'], { cwd: resolve('../zhilume-studio'), env: { ...process.env, ZHILUME_DEV_SERVER: base }, windowsHide: true, stdio: ['ignore', logFd, logFd] });
  await until(async () => { try { return (await fetch('http://127.0.0.1:5412')).ok; } catch { return false; } }, Boolean, 60);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  evidence.pageErrors = [];
  page.on('pageerror', e => evidence.pageErrors.push(e.message));
  page.on('response', r => { if (r.status() >= 400) console.log('HTTP', r.status(), new URL(r.url()).pathname); });
  await page.addInitScript(value => sessionStorage.setItem('zhilume.session', value), token);
  await page.goto('http://127.0.0.1:5412');
  await page.getByText(project.name, { exact: true }).click();
  await page.locator('.react-flow__node[data-id="image"]').click();
  const panel = page.getByRole('region', { name: '图片生成与编辑' });
  await expect(panel).toBeVisible();
  await panel.getByLabel('提示词', { exact: true }).fill('A small blue ceramic cup on a wooden table, soft daylight.');
  await expect(panel.getByRole('button', { name: '提交生成', exact: true })).toBeEnabled();
  const submitted = page.waitForResponse(r => r.url().endsWith('/api/v1/jobs') && r.request().method() === 'POST');
  await panel.getByRole('button', { name: '提交生成', exact: true }).click();
  const response = await submitted; assert.equal(response.status(), 201); job = await response.json();
  console.log('Studio submitted real GPU job');
  const states = [];
  const done = await until(async () => { const j = await api('/jobs/' + job.id); if (states.at(-1) !== j.status) { states.push(j.status); console.log(j.status, j.stage); } return j; }, j => ['succeeded', 'failed', 'cancelled'].includes(j.status), 600);
  assert.equal(done.status, 'succeeded', done.error);
  const canvas = await until(() => api('/projects/' + project.id + '/canvas'), c => c.nodes.some(n => n.data.assetId === done.outputAssetId), 45);
  const node = canvas.nodes.find(n => n.data.assetId === done.outputAssetId);
  const img = page.locator('.react-flow__node[data-id="' + node.id + '"] img').first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate(e => e.complete && e.naturalWidth === 512)).toBe(true);
  await page.getByTitle('关闭任务面板', { exact: true }).click();
  await page.getByTitle('适应全部内容', { exact: true }).click();
  await expect(img).toBeInViewport();
  await page.screenshot({ path: join(root, 'studio-real-gpu.png') });
  const asset = await api('/assets/' + done.outputAssetId);
  const content = await app.inject({ method: 'GET', url: '/api/v1/assets/' + asset.id + '/content', headers });
  assert.equal(createHash('sha256').update(content.rawPayload).digest('hex'), asset.sha256);
  await writeFile(join(root, 'generated.png'), content.rawPayload);
  const overview = await until(() => manage('overview'), o => !o.tasks.length);
  assert.equal(overview.resourceQuarantined, false);
  assert.ok(overview.gpus.every(g => Number(g.usedMiB) < 1536));
  evidence.passed = true; evidence.jobStates = states; evidence.resultArchived = true; evidence.canvasSaved = true; evidence.imageRendered = true; evidence.asset = { size: asset.size, sha256: asset.sha256 }; evidence.gpus = overview.gpus;
} catch (error) {
  evidence.error = error.message;
  if (page) { await page.screenshot({ path: join(root, 'failure.png') }); evidence.visibleError = (await page.locator('body').innerText()).slice(0, 3000); }
  throw error;
}
finally {
  if (job) { try { const j = await api('/jobs/' + job.id); if (!['succeeded','failed','cancelled'].includes(j.status)) await api('/jobs/' + job.id + '/cancel', {}); } catch {} }
  if (browser) await browser.close();
  if (vite && vite.exitCode === null) {
    const exited = once(vite, 'exit');
    if (process.platform === 'win32') await once(spawn('taskkill', ['/PID', String(vite.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }), 'exit');
    else vite.kill();
    await exited;
  }
  if (logFd !== undefined) closeSync(logFd);
  try { await operation('runtimes/comfy-main/stop'); } catch (e) { evidence.cleanupError = e.message; process.exitCode = 1; }
  await app.close(); evidence.finishedAt = new Date().toISOString();
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2));
}
