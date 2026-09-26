import { startWorker } from "./worker-helper.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../src/server.js';

test('Linux deployment launcher registers, returns output and reuses its private identity', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'zhilume-deployment-test-'));
  const app = await createApp({ root: join(root, 'server'), token: 'deployment-test-only', tickMs: 50 });
  let child: ChildProcess | undefined;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
  t.after(async () => {
    await stop(); await app.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'zhilume-deployment-test-'));
    await rm(root, { recursive: true, force: true });
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  async function api(path: string, body?: object) {
    const response = await fetch(base + '/api/v1' + path, {
      method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer deployment-test-only', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  }
  async function wait(get: () => Promise<any>, ready: (value: any) => boolean) {
    for (let i = 0; i < 100; i++) { const value = await get(); if (ready(value)) return value; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('Deployment launcher did not reach expected state');
  }
  const state = join(root, 'worker');
  const peer = await startWorker(state, [], undefined, true);
  child = peer.child;
  await api('/workers', { address: peer.address, credential: peer.credential });
  const first = await wait(() => api('/workers'), rows => rows.length === 1 && rows[0].connected);
  assert.equal(first[0].platform, 'Linux');
  assert.ok(first[0].capabilities.includes('mock.text.echo.v1'));
  assert.ok(!first[0].capabilities.some((name: string) => name.startsWith('image.')));
  const identity = await readFile(join(state, 'identity.json'));
  assert.equal((await stat(join(state, 'identity.json'))).mode & 0o777, 0o600);
  const project = await api('/projects', { name: 'Linux 启动脚本验收' });
  const job = await api('/jobs', { requestId: crypto.randomUUID(), projectId: project.id, operation: 'mock.text.echo.v1', input: { text: 'Linux 启动脚本 ✓' } });
  const done = await wait(() => api('/jobs/' + job.id), value => ['succeeded', 'failed'].includes(value.status));
  assert.equal(done.status, 'succeeded');
  assert.equal(await fetch(base + done.output.url).then(r => r.text()), 'Linux 启动脚本 ✓');
  await stop();
  await wait(() => api('/workers'), rows => !rows[0].connected);
  child = (await startWorker(state, [], peer.port, true)).child;
  const next = await wait(() => api('/workers'), rows => rows.length === 1 && rows[0].connected);
  assert.equal(next[0].id, first[0].id);
  assert.deepEqual(await readFile(join(state, 'identity.json')), identity);
});
