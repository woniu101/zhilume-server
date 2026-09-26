'use strict';
const { spawn } = require('node:child_process');
const { stat, rm } = require('node:fs/promises');

const OPERATIONS = Object.freeze(['media.video.trim.v1', 'media.audio.extract.v1']);
const MAX_BYTES = 1024 ** 3;
class MediaError extends Error {
  constructor(code, message) { super(message); this.name = 'MediaError'; this.code = code; }
}
function validate(operation, parameters) {
  if (!OPERATIONS.includes(operation)) throw new MediaError('unsupported_operation', '不支持的媒体操作');
  const { start, end } = parameters || {};
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end > 86400)
    throw new MediaError('invalid_range', '开始和结束时间必须在 0 至 86400 秒之间，且结束晚于开始');
  return { start, end };
}
function format(operation) {
  if (!OPERATIONS.includes(operation)) throw new MediaError('unsupported_operation', '不支持的媒体操作');
  return operation === OPERATIONS[0]
    ? { filename: 'clip.mp4', mimeType: 'video/mp4', kind: 'video' }
    : { filename: 'audio.wav', mimeType: 'audio/wav', kind: 'audio' };
}
function aborted(signal) {
  if (signal?.aborted) throw new MediaError('cancelled', '已取消处理');
}
const inputOptions = ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska'];
function argumentsFor(operation, parameters, input, output) {
  const { start, end } = validate(operation, parameters);
  return [...inputOptions, '-y', '-i', input, '-ss', String(start), '-t', String(end - start),
    ...(operation === OPERATIONS[0]
      ? ['-map', '0:v:0', '-map', '0:a:0?', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart']
      : ['-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le']),
    '-threads', '2', '-progress', 'pipe:1', '-nostats', output];
}
function childRun(executable, args, signal, onLine) {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', pending = '', spawnError;
    const cancel = () => { child.kill(); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.on('error', error => { spawnError = error; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) onLine?.(line);
    });
    child.on('close', code => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) reject(new MediaError('cancelled', '已取消处理'));
      else if (spawnError) reject(new MediaError('ffmpeg_unavailable', '内置 FFmpeg 无法启动，请检查安装包是否完整'));
      else resolve({ code, stderr });
    });
  });
}
async function processFile({ executable, input, output, operation, parameters, signal, onProgress = () => {} }) {
  const params = validate(operation, parameters);
  aborted(signal);
  const source = await stat(input).catch(() => { throw new MediaError('source_missing', '原始素材不存在，请重新导入'); });
  if (!source.isFile() || !source.size || source.size > MAX_BYTES) throw new MediaError('input_limit', '原始素材必须为有效文件且不超过 1 GB');
  onProgress({ phase: 'validating', progress: null });
  // Probe using the same bundled binary; this does not decode the whole video.
  const probe = await childRun(executable, [...inputOptions, '-i', input], signal);
  const durationMatch = probe.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!durationMatch || !/Stream #.*Video:/.test(probe.stderr)) throw new MediaError('invalid_media', '素材不是可读取的视频，或缺少有效时长');
  const duration = +durationMatch[1] * 3600 + +durationMatch[2] * 60 + +durationMatch[3];
  if (params.start >= duration || params.end > duration + .05) throw new MediaError('invalid_range', '截取范围超出原视频时长');
  if (operation === OPERATIONS[1] && !/Stream #.*Audio:/.test(probe.stderr)) throw new MediaError('no_audio', '视频没有可提取的音轨');
  aborted(signal);
  onProgress({ phase: 'processing', progress: 0 });
  try {
    let progress = 0;
    const result = await childRun(executable, argumentsFor(operation, params, input, output), signal, line => {
      if (!line.startsWith('out_time_us=')) return;
      const value = Number(line.slice(12));
      if (Number.isFinite(value)) { progress = Math.max(progress, Math.min(.99, Math.max(0, value / 1e6 / (params.end - params.start)))); onProgress({ phase: 'processing', progress }); }
    });
    if (result.code !== 0) {
      if (/No space left|Disk quota exceeded/.test(result.stderr)) throw new MediaError('disk_full', '磁盘空间不足，请清理空间后重试');
      throw new MediaError('processing_failed', '媒体处理失败，请检查素材是否损坏或编码不受支持');
    }
    aborted(signal);
    const size = (await stat(output)).size;
    if (size < 64 || size > MAX_BYTES) throw new MediaError('output_limit', '处理结果为空或超过 1 GB 限制');
    onProgress({ phase: 'processing', progress: 1 });
    return { ...format(operation), size, path: output };
  } catch (error) {
    await rm(output, { force: true }).catch(() => {});
    throw error;
  }
}
module.exports = { OPERATIONS, MAX_BYTES, MediaError, validate, format, argumentsFor, processFile };
