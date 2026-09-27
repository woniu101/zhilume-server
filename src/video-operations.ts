import { readFileSync } from 'node:fs';
import { AppError, text, requireValue } from './domain.js';
import { online } from './image-operations.js';
const catalog = JSON.parse(readFileSync(new URL('../contracts/operation-catalog.json', import.meta.url), 'utf8'));
export const videoModels: any[] = catalog.videoModels;
export const videoCapabilities: any[] = catalog.videoOperations;
export const isVideoOperation = (op: string) => op === 'video.generate.v1';
const int = (n: any, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
const frames = (n: any, min = 124) => int(n, min, 345) && n % 17 === 5;
const fail = (message: string): never => { throw new AppError('invalid_video', message); };
export function validateVideoProfiles(value: any): any[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return fail('视频配置无效');
  const seen = new Set();
  return value.map(p => {
    const model = videoModels.find(m => m.id === p?.modelId);
    if (!model || !/^[a-f0-9]{64}$/.test(p.profileId) || seen.has(p.profileId) || p.workflowRevision !== model.workflowRevision || p.validation !== 'unverified' || p.fps !== 24 ||
      !Array.isArray(p.modes) || JSON.stringify(p.modes) !== JSON.stringify(model.modes) ||
      !Array.isArray(p.sizes) || !p.sizes.length || p.sizes.length > 16 || p.sizes.some((s: any) => !Array.isArray(s) || s.length !== 2 || s.some((n: any) => !int(n,256,1344) || n % 32) || s[0]*s[1] > 1344*768) ||
      !Array.isArray(p.frames) || !p.frames.length || p.frames.length > 14 || p.frames.some((n: any) => !frames(n)) ||
      !int(p.defaultSteps,1,50) || p.maxSteps !== 50 || !p.referenceLimits || !int(p.referenceLimits.image,0,9) || !int(p.referenceLimits.video,0,3) || !int(p.referenceLimits.audio,0,3)) return fail('视频配置与模型契约不一致');
    seen.add(p.profileId);
    return { modelId: model.id, profileId: p.profileId, workflowRevision: p.workflowRevision, modes: model.modes, sizes: p.sizes, frames: p.frames,
      fps: 24, referenceLimits: { image:p.referenceLimits.image, video:p.referenceLimits.video, audio:p.referenceLimits.audio }, defaultSteps:p.defaultSteps, maxSteps:50, validation:'unverified' };
  });
}
export function videoAvailability(workers: any[]) {
  return videoModels.map(m => { const profiles = [...new Map(workers.filter(online).flatMap(w => w.videoProfiles || []).filter(p => p.modelId === m.id).map(p => [p.profileId,p])).values()]; return { ...m, profiles, ready: profiles.length > 0 }; });
}
export function validateVideoInput(b: any, workers: any[], lookup: (id: string) => any) {
  const model = videoAvailability(workers).find(m => m.id === b?.modelId);
  const p: any = model?.profiles.find((p: any) => p.profileId === b.profileId);
  if (!p || b.workflowRevision !== p.workflowRevision) throw new AppError('model_unavailable','视频配置已离线或变更，请刷新',409);
  if (!p.modes.includes(b.mode) || !p.frames.includes(b.frames) || !p.sizes.some((s: number[]) => s[0] === b.width && s[1] === b.height) || !int(b.seed,0,Number.MAX_SAFE_INTEGER) || !int(b.steps,1,50) || typeof b.includeAudio !== 'boolean') return fail('视频参数超出执行配置');
  if (!Array.isArray(b.references) || b.references.length > 12) return fail('参考最多 12 个');
  const roles = b.references.map((r: any) => r?.role);
  const expected: Record<string,string[]> = { text:[], first:['first'], last:['last'], 'first-last':['first','last'] };
  if (b.mode !== 'reference' ? JSON.stringify(roles) !== JSON.stringify(expected[b.mode]) : !roles.length || roles.some((r: string) => !['image','video','audio'].includes(r))) return fail('参考角色不完整');
  for (const kind of ['image','video','audio']) if (roles.filter((r: string) => r === kind).length > p.referenceLimits[kind]) return fail('参考数量超过执行配置');
  const totals: Record<string,number> = { video:0, audio:0 };
  const references = b.references.map((r: any) => {
    const asset = requireValue(lookup(text(r.assetId,100)), '参考素材不存在');
    const kind = ['first','last'].includes(r.role) ? 'image' : r.role;
    if (asset.staged || asset.kind !== kind || asset.size > (kind === 'image' ? 64 : 256) * 1024**2) return fail('参考类型或大小不符合要求');
    if (kind === 'image') return { role:r.role, assetId:asset.id };
    if (!Number.isFinite(r.start) || r.start < 0 || r.start > 86400 || !frames(r.frames,56) || r.frames > b.frames) return fail('参考片段至少 56 帧，按 17 帧递增且不超过输出时长');
    totals[kind] += r.frames / 24;
    return { role:r.role, assetId:asset.id, start:r.start, frames:r.frames };
  });
  if (Object.values(totals).some(n => n > 15)) return fail('视频、音频参考累计时长各不超过 15 秒');
  return { modelId:b.modelId, profileId:p.profileId, workflowRevision:p.workflowRevision, mode:b.mode, prompt:text(b.prompt,20000), width:b.width, height:b.height,
    frames:b.frames, fps:24, steps:b.steps, seed:b.seed, includeAudio:b.includeAudio, references, referenceAssetIds:[...new Set(references.map((r: any) => r.assetId))], outputFormat:'mp4' };
}
export const supportsVideoJob = (w: any, j: any) => !isVideoOperation(j.operation) || (w.videoProfiles || []).some((p: any) => p.modelId === j.input.modelId && p.profileId === j.input.profileId && p.workflowRevision === j.input.workflowRevision);
export function validateVideoDraft(d: any) {
  const str = (v: any, max: number) => typeof v === 'string' && v.length <= max;
  if (!d || !videoModels.some(m => m.id === d.modelId) || !str(d.profileId,64) || !['text','first','last','first-last','reference'].includes(d.mode) || !str(d.prompt,100000) ||
    !str(d.firstFrameId,100) || !str(d.lastFrameId,100) || !int(d.width,256,1344) || !int(d.height,256,1344) || !frames(d.frames) || !int(d.steps,1,50) || !int(d.seed,0,Number.MAX_SAFE_INTEGER) || typeof d.includeAudio !== 'boolean' ||
    !Array.isArray(d.references) || d.references.length > 1000 || d.references.some((r: any) => !r || !['image','video','audio'].includes(r.role) || !str(r.assetId,100) || !Number.isFinite(r.start) || r.start < 0 || r.start > 86400 || !frames(r.frames,56)) ||
    (d.request !== undefined && (!str(d.request?.id,100) || !d.request.id || !str(d.request?.fingerprint,100000)))) fail('视频草稿结构不合法');
}
