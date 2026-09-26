import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';

export async function startWorker(state: string, args: string[] = [], port?: number, launcher = false) {
  if (!port) { const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); port = (listener.address() as any).port; await new Promise<void>(r => listener.close(() => r())); }
  const python = process.env.ZHILUME_TEST_PYTHON || resolve('../zhilume-worker/.venv/' + (process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  const child = launcher
    ? spawn('bash', ['deploy/run.sh'], { cwd: resolve('../zhilume-worker'), env: { ...process.env, ZHILUME_STATE: state, ZHILUME_HOST: '127.0.0.1', ZHILUME_PORT: String(port), ZHILUME_ENABLE_IMAGE: '0' }, stdio: ['ignore', 'ignore', 'pipe'] })
    : spawn(python, ['-m', 'zhilume_worker', '--port', String(port), '--state', state, ...args], { cwd: resolve('../zhilume-worker'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = ''; child.stderr?.on('data', b => { log = (log + b.toString()).slice(-2500); });
  const address = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error('Worker exited: ' + log);
    try {
      const identity = JSON.parse(await readFile(join(state, 'identity.json'), 'utf8'));
      const response = await fetch(address + '/api/v1/system', { headers: { Authorization: 'Bearer ' + identity.credential }, signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, address, credential: identity.credential, workerId: identity.workerId, port: port!, log: () => log };
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill(); throw new Error('Worker startup timeout: ' + log);
}
export async function stopWorker(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(); await exited;
}
