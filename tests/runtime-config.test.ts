import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const { resolveRuntimeConfig } = createRequire(import.meta.url)('../runtime/config.cjs');

test('CLI and credential command share launcher configuration without inherited ZHILUME_DATA', () => {
  const root = mkdtempSync(join(tmpdir(), 'zhilume-config-'));
  try {
    const userDirectory = join(root, 'zhilume-server');
    const data = join(root, 'custom-data');
    mkdirSync(userDirectory); mkdirSync(data);
    writeFileSync(join(userDirectory, 'launcher-config.json'), JSON.stringify({ dataDirectory: data, port: 4510, closeBehavior: 'tray' }));
    writeFileSync(join(data, 'admin-token'), 'fixture-only-token');
    const env = { ...process.env, ZHILUME_USER_DATA: userDirectory };
    delete env.ZHILUME_DATA; delete env.ZHILUME_TOKEN; delete env.ZHILUME_PORT;
    assert.equal(resolveRuntimeConfig(env).dataDirectory, data);
    assert.equal(resolveRuntimeConfig(env).port, 4510);
    assert.equal(resolveRuntimeConfig(env).closeBehavior, 'tray');
    const result = spawnSync(process.execPath, ['scripts/credential.mjs'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(result.stdout.trim(), 'fixture-only-token');
    const missing = spawnSync(process.execPath, ['scripts/credential.mjs'], { env: { ...env, ZHILUME_DATA: join(root, 'missing') }, encoding: 'utf8' });
    assert.equal(missing.status, 1); assert.equal(missing.stdout, '');
    assert.ok(missing.stderr.includes(join(root, 'missing')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('platform defaults, explicit overrides and first-run close behavior', () => {
  const root = mkdtempSync(join(tmpdir(), 'zhilume-defaults-'));
  try {
    assert.equal(resolveRuntimeConfig({ APPDATA: root }, 'win32', root).dataDirectory, join(root, 'zhilume-server', 'data'));
    assert.equal(resolveRuntimeConfig({ XDG_CONFIG_HOME: root }, 'linux', root).dataDirectory, join(root, 'zhilume-server', 'data'));
    assert.equal(resolveRuntimeConfig({ ZHILUME_USER_DATA: root }, 'win32', root).closeBehavior, 'ask');
    assert.equal(resolveRuntimeConfig({ ZHILUME_USER_DATA: root, ZHILUME_DATA: join(root, 'override') }).dataDirectory, join(root, 'override'));
    assert.throws(() => resolveRuntimeConfig({ ZHILUME_USER_DATA: root, ZHILUME_PORT: 'invalid' }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
