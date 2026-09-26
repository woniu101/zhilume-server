import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.js';
import { startWorker, stopWorker } from './worker-helper.js';

test('Server with no listening port connects to Worker, authenticates and archives output', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'zhilume-outbound-test-'));
  const peer = await startWorker(join(root, 'worker'), ['--delay', '0.1']);
  let app = await createApp({ root: join(root, 'server'), token: 'outbound-test-only', tickMs: 50 });
  t.after(async () => {
    await app.close(); await stopWorker(peer.child);
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'zhilume-outbound-test-')); await rm(root, { recursive: true, force: true });
  });
  const call = (method: any, path: string, body?: object) => app.inject({ method, url: '/api/v1' + path, headers: { Authorization: 'Bearer outbound-test-only' }, payload: body });
  const config = { address: peer.address, credential: peer.credential };
  assert.equal((await call('POST', '/workers/probe', { ...config, credential: 'invalid-worker-secret' })).json().code, 'worker_auth_failed');
  assert.equal((await call('POST', '/workers/probe', { ...config, address: 'file:///tmp/data' })).json().code, 'invalid_address');
  assert.equal((await call('POST', '/workers/probe', config)).json().workerId, peer.workerId);
  assert.equal((await call('GET', '/workers')).json().length, 0, 'probe must not save a connection');
  assert.equal((await call('POST', '/workers', config)).statusCode, 201);
  assert.equal((await call('POST', '/workers', config)).statusCode, 409);
  async function wait(path: string, ready: (value: any) => boolean) {
    for (let i = 0; i < 200; i++) { const v = (await call('GET', path)).json(); if (ready(v)) return v; await new Promise(r => setTimeout(r, 50)); }
    throw Error('Outbound connection timeout');
  }
  await wait('/workers', rows => rows[0].connected);
  assert.equal(app.server.listening, false, 'no inbound Server port is available to Worker');
  assert.ok(!(await call('GET', '/workers')).body.includes(peer.credential));
  const project = (await call('POST', '/projects', { name: 'No inbound port' })).json();
  const job = (await call('POST', '/jobs', { projectId: project.id, requestId: crypto.randomUUID(), operation: 'mock.text.echo.v1', input: { text: 'Server 主动连接 ✓' } })).json();
  const done = await wait('/jobs/' + job.id, j => ['succeeded', 'failed'].includes(j.status));
  assert.equal(done.status, 'succeeded');
  assert.equal((await app.inject({ method: 'GET', url: done.output.url })).body, 'Server 主动连接 ✓');
  await app.close();
  app = await createApp({ root: join(root, 'server'), token: 'outbound-test-only', tickMs: 50 });
  await app.ready();
  await wait('/workers', rows => rows[0].connected);
  assert.equal((await call('GET', '/workers')).json()[0].id, peer.workerId, 'Server restart reuses its identity and credential');
  assert.equal((await call('PATCH', '/workers/' + peer.workerId, { disabled: true })).statusCode, 200);
  await wait('/workers', rows => !rows[0].connected);
  assert.equal((await call('PATCH', '/workers/' + peer.workerId, { disabled: false })).statusCode, 200);
  await wait('/workers', rows => rows[0].connected);
});
