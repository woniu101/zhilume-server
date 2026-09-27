import media from '@zhilume/media';
import { createRequire } from 'node:module';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { Assets } from './assets.js';
import { terminal } from './domain.js';
const ffmpeg: string = createRequire(import.meta.url)('ffmpeg-static');

/** One native process at a time; independent of every Worker connection. */
export class ServerMediaQueue {
  readonly executable: string;
  readonly ready: boolean;
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  private closing = false;
  constructor(private store: Store, private assets: Assets, private changed: (job: any) => void, executable?: string) {
    this.executable = executable || (ffmpeg || '').replace('app.asar', 'app.asar.unpacked');
    this.ready = existsSync(this.executable);
    for (const job of store.all('job')) if (job.executor === 'server' && ['assigned', 'running', 'cancel_requested'].includes(job.status)) {
      Object.assign(job, { status: 'interrupted', stage: 'Server 已重启', error: '本地媒体任务已中断，请重试', errorCode: 'server_restarted' });
      this.changed(job);
    }
  }
  cancel(id: string) { if (this.active?.id === id) this.active.abort.abort(); }
  pump() {
    if (this.closing || this.active || !this.ready) return;
    const job = this.store.all('job').filter(j => j.executor === 'server' && j.status === 'queued').reverse()[0];
    if (!job) return;
    const abort = new AbortController();
    Object.assign(job, { status: 'running', stage: '校验原始素材', progress: null }); this.changed(job);
    // Defer execution until active is assigned, including failures before first await.
    const done = Promise.resolve().then(() => this.execute(job, abort.signal)).finally(() => { this.active = undefined; this.pump(); });
    this.active = { id: job.id, abort, done };
  }
  private async execute(original: any, signal: AbortSignal) {
    let directory: string | undefined, outputAsset: any;
    const update = (values: any) => {
      const job = this.store.get('job', original.id);
      if (job?.attemptId === original.attemptId) this.changed(Object.assign(job, values));
    };
    try {
      const input = this.store.get('asset', original.input.assetId);
      if (!input || input.staged) throw new media.MediaError('source_missing', '原始素材不存在');
      const root = join(this.store.root, 'media-tasks'); await mkdir(root, { recursive: true });
      directory = await mkdtemp(join(root, 'task-'));
      const result = await media.processFile({ executable: this.executable, input: this.assets.path(input),
        output: join(directory, media.format(original.operation).filename), operation: original.operation, parameters: original.input, signal,
        onProgress: value => { if (!signal.aborted) update({ stage: value.phase === 'validating' ? '校验原始素材' : 'Server 媒体处理中', progress: value.progress }); },
      });
      signal.throwIfAborted(); update({ stage: '归档处理结果', progress: 1 });
      outputAsset = await this.assets.ingest(createReadStream(result.path, { signal }), result.filename, {
        staged: true, jobId: original.id, provenance: { operation: original.operation, sourceAssetIds: [input.id], parameters: { start: original.input.start, end: original.input.end } },
      });
      signal.throwIfAborted();
      this.store.atomic(() => {
        this.store.put('asset', { ...outputAsset, staged: false });
        update({ status: 'succeeded', stage: '已归档', progress: 1, outputAssetId: outputAsset.id, error: null, errorCode: null });
      });
      outputAsset = undefined;
    } catch (error: any) {
      if (outputAsset) { this.store.remove('asset', outputAsset.id); await rm(this.assets.path(outputAsset), { force: true }); }
      update(this.closing
        ? { status: 'interrupted', stage: 'Server 已停止', error: 'Server 关闭导致媒体任务中断，请重试', errorCode: 'server_stopped' }
        : signal.aborted
        ? { status: 'cancelled', stage: '已取消', error: null, errorCode: null }
        : { status: 'failed', stage: '处理失败', error: error instanceof media.MediaError ? error.message : '媒体文件读写失败，请检查磁盘空间和权限', errorCode: error instanceof media.MediaError ? error.code : 'io_error' });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }
  async close() { this.closing = true; this.active?.abort.abort(); await this.active?.done; }
}
