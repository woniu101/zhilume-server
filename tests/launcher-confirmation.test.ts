import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createConfirmation } = createRequire(import.meta.url)('../runtime/confirmation.cjs');

test('close confirmation rejects stale and invalid replies, preserves remember choice and cannot replay', async () => {
  const confirmation = createConfirmation(() => {});
  const answer = confirmation.request('close', { running: true });
  const id = confirmation.current.id;
  assert.throws(() => confirmation.respond({ id: 'stale', action: 'quit' }));
  assert.throws(() => confirmation.respond({ id, action: 'stop' }));
  assert.equal((await confirmation.request('close')).action, 'cancel');
  confirmation.respond({ id, action: 'tray', remember: true });
  assert.deepEqual(await answer, { action: 'tray', remember: true });
  assert.equal(confirmation.current, null);
  assert.throws(() => confirmation.respond({ id, action: 'quit' }));
});

test('cancellation and busy-task confirmation cannot silently stop or persist a close choice', async () => {
  const confirmation = createConfirmation(() => {});
  const close = confirmation.request('close');
  confirmation.cancel();
  assert.deepEqual(await close, { action: 'cancel', remember: false });
  const stop = confirmation.request('stop', { taskCount: 2 });
  assert.throws(() => confirmation.respond({ id: confirmation.current.id, action: 'quit' }));
  confirmation.respond({ id: confirmation.current.id, action: 'stop', remember: true });
  assert.deepEqual(await stop, { action: 'stop', remember: false });
});
