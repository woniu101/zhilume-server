import { readFileSync } from 'node:fs';
import { AppError, text, requireValue } from './domain.js';
import { online } from './image-operations.js';
const catalog = JSON.parse(readFileSync(new URL('../contracts/operation-catalog.json', import.meta.url), 'utf8'));
export const speechModels: any[] = catalog.speechModels;
export const speechCapabilities: any[] = catalog.speechOperations;
export const isSpeechOperation = (op: string) => speechCapabilities.some(c => c.id === op);
const finite = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;

export function validateSpeechProfiles(value: unknown): any[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new AppError('invalid_profiles', '语音执行配置无效');
  const ids = new Set();
  return value.map(p => {
    const model = speechModels.find(m => m.id === p?.modelId);
    if (!model || !/^[a-f0-9]{64}$/.test(p.profileId) || ids.has(p.profileId) || p.workflowRevision !== model.workflowRevision ||
      p.upstreamRevision !== model.upstreamRevision || p.validation !== 'unverified' ||
      !Number.isInteger(p.maxTextCharacters) || !finite(p.maxTextCharacters, 1, model.maxTextCharacters) ||
      !Array.isArray(p.languages) || !p.languages.length || p.languages.some((s: string) => !model.languages.includes(s)) ||
      !Array.isArray(p.emotionModes) || !p.emotionModes.includes('follow') || p.emotionModes.some((s: string) => !model.emotionModes.includes(s)))
      throw new AppError('invalid_profiles', '语音执行配置与模型契约不一致');
    ids.add(p.profileId);
    return { modelId: model.id, profileId: p.profileId, workflowRevision: p.workflowRevision, upstreamRevision: p.upstreamRevision,
      maxTextCharacters: p.maxTextCharacters, languages: [...new Set(p.languages)], emotionModes: [...new Set(p.emotionModes)], validation: 'unverified' };
  });
}
export function speechAvailability(workers: any[]) {
  return speechModels.map(m => { const profiles = [...new Map(workers.filter(online).flatMap(w => w.speechProfiles || []).filter(p => p.modelId === m.id).map(p => [p.profileId, p])).values()]; return { ...m, profiles, ready: profiles.length > 0 }; });
}
export function validateSpeechInput(b: any, workers: any[], lookup: (id: string) => any) {
  const model = speechModels.find(m => m.id === b?.modelId);
  const profile: any = model && speechAvailability(workers).find(m => m.id === model.id)!.profiles.find((p: any) => p.profileId === b.profileId);
  if (!profile || profile.workflowRevision !== b.workflowRevision) throw new AppError('model_unavailable', '语音配置已离线或变更，请刷新后重试', 409);
  if (!profile.languages.includes(b.language) || !profile.emotionModes.includes(b.emotionMode) || !finite(b.speed, model.minSpeed, model.maxSpeed) || !finite(b.emotionAlpha, 0, 1)) throw new AppError('invalid_parameters', '语言、语速或情绪模式不受支持');
  const content = text(b.text, profile.maxTextCharacters);
  const reference = (r: any) => {
    if (!r || !finite(r.start, 0, 86400) || !finite(r.end, 0, 86400) || r.end - r.start < 1 || r.end - r.start > model.maxReferenceSeconds) throw new AppError('invalid_reference', '参考片段应为 1–30 秒');
    const a = requireValue(lookup(text(r.assetId, 100)), '参考音频不存在');
    if (a.kind !== 'audio' || a.staged || a.size > 64 * 1024 ** 2) throw new AppError('invalid_reference', '请选择已归档、64 MB 以内的音频');
    return { assetId: a.id, start: r.start, end: r.end };
  };
  const speaker = reference(b.speaker);
  const emotionReference = b.emotionMode === 'reference' ? reference(b.emotionReference) : null;
  const emotionText = b.emotionMode === 'text' ? text(b.emotionText, 500) : '';
  const emotionVector = b.emotionMode === 'vector' ? b.emotionVector : Array(8).fill(0);
  if (!Array.isArray(emotionVector) || emotionVector.length !== 8 || emotionVector.some(n => !finite(n, 0, 1))) throw new AppError('invalid_parameters', '情绪强度须为 8 个 0–1 数值');
  return { modelId: model.id, profileId: profile.profileId, workflowRevision: profile.workflowRevision, text: content, language: b.language, speed: b.speed,
    speaker, emotionMode: b.emotionMode, emotionAlpha: b.emotionAlpha, emotionReference, emotionText, emotionVector,
    referenceAssetIds: [...new Set([speaker.assetId, ...(emotionReference ? [emotionReference.assetId] : [])])], outputFormat: 'wav' };
}
export function supportsSpeechJob(w: any, j: any) {
  return !isSpeechOperation(j.operation) || (w.speechProfiles || []).some((p: any) => p.modelId === j.input.modelId && p.profileId === j.input.profileId && p.workflowRevision === j.input.workflowRevision);
}

export function validateSpeechDraft(d: any) {
  const str = (v: unknown, n: number) => typeof v === 'string' && v.length <= n;
  const clip = (c: any) => c && str(c.assetId, 100) && finite(c.start, 0, 86400) && finite(c.end, 0, 86400);
  if (!d || d.modelId !== 'indextts-2.5' || !str(d.profileId, 64) || !str(d.text, 100000) || !['ZH','EN','JA','ES','AR'].includes(d.language) ||
    !finite(d.speed, .5, 2) || !finite(d.emotionAlpha, 0, 1) || !['follow','reference','vector','text'].includes(d.emotionMode) ||
    !str(d.emotionText, 500) || !Array.isArray(d.emotionVector) || d.emotionVector.length !== 8 || d.emotionVector.some((n: unknown) => !finite(n, 0, 1)) ||
    !clip(d.speaker) || !clip(d.emotionReference) || (d.request !== undefined && (!str(d.request?.id,100) || !d.request.id || !str(d.request?.fingerprint,16000))))
    throw new AppError('invalid_speech_draft', '语音草稿结构或长度不合法');
}
