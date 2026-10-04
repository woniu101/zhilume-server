import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
const executable = (createRequire(import.meta.url)('ffmpeg-static') as string || '').replace('app.asar', 'app.asar.unpacked');
let active = 0;
const waiting: (() => void)[] = [];

/** Probe once at ingestion, with bounded concurrency/time/output and no network protocols. */
export async function assetMetadata(path: string, kind: string) {
  if (kind === 'text') return undefined;
  if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
  else active++;
  try {
    const stderr = await new Promise<string>(resolve => execFile(executable, ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-probesize', '1048576', '-analyzeduration', '1000000', '-i', path], { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 }, (_error, _out, err) => resolve(String(err))));
    const video = stderr.split(/\r?\n/).find(line => line.includes('Video:'));
    const dimensions = video?.split('Video:')[1].match(/\b(\d{1,6})x(\d{1,6})\b/);
    const time = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    const duration = time ? Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]) : undefined;
    return { status: dimensions || duration !== undefined ? 'ready' : 'unavailable',
      ...(dimensions ? { width: Number(dimensions[1]), height: Number(dimensions[2]) } : {}),
      ...(duration !== undefined && kind !== 'image' ? { duration } : {}) };
  } finally { const next = waiting.shift(); if (next) next(); else active--; }
}
