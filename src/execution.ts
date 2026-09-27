import { supportsLanguageJob } from './worker-language.js';
import { createHash } from 'node:crypto';
import { AppError, terminal } from './domain.js';
import { online, supportsImageJob } from './image-operations.js';
import { supportsSpeechJob } from './speech-operations.js';
import { supportsVideoJob } from './video-operations.js';

export function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const fingerprint = (v: any) => createHash('sha256').update(canonical(v)).digest('hex');
export function validateIdentity(p: any) {
  const x = p?.identity;
  if (!x || typeof x.revision !== 'string' || !x.revision || typeof x.quantization !== 'string' || !x.quantization ||
      !x.artifacts || typeof x.artifacts !== 'object' || !Object.keys(x.artifacts).length ||
      Object.values(x.artifacts).some(v => typeof v !== 'string' || !/^(sha256:[a-f0-9]{64}|revision:[A-Za-z0-9_.@-]{3,160})$/.test(v as string)))
    throw new AppError('invalid_spec_identity', '执行规格必须声明权重版本、量化和各组件的不可变标识');
  if (JSON.stringify(x).includes('REPLACE') || x.quantization.startsWith('declare-')) throw new AppError('invalid_spec_identity', '执行规格不能使用示例占位符');
  const { profileId, ...spec } = p;
  if (fingerprint(spec) !== profileId) throw new AppError('invalid_spec_hash', '执行规格摘要不匹配');
  return structuredClone(x);
}
export function validateDeployment(value: any) {
  if (value?.capacity !== 1 || !Array.isArray(value.resourceIds) || !value.resourceIds.length || value.resourceIds.length > 16 ||
      value.resourceIds.some((r: any) => typeof r !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(r)))
    throw new AppError('invalid_deployment', '执行端必须声明容量 1 和共享资源标识');
  return { capacity: 1, resourceIds: [...new Set(value.resourceIds)] };
}
export function availableProfiles(workers: any[], key: string, modelId: string) {
  const specs = new Map<string, any>();
  for (const w of workers) for (const p of w[key] || []) if (p.modelId === modelId) {
    const current = specs.get(p.profileId) || { ...p, workers: [], readyCount: 0, endpointCount: 0 };
    if (w.id !== 'registry') { current.workers.push({ id: w.id, name: w.name, ready: online(w) }); current.endpointCount++; if (online(w)) current.readyCount++; }
    specs.set(p.profileId, current);
  }
  return [...specs.values()];
}
export function route(job: any, workers: any[], jobs: any[], connected: (id: string) => boolean) {
  const matching = workers.filter(w => (!job.targetWorkerId || job.targetWorkerId === w.id) && w.capabilities.includes(job.operation) &&
    supportsImageJob(w, job) && supportsSpeechJob(w, job) && supportsVideoJob(w, job) && supportsLanguageJob(w, job));
  const ready = matching.filter(w => online(w) && connected(w.id));
  const busy = jobs.filter(j => j.executor === 'worker' && ['assigned', 'running', 'cancel_requested'].includes(j.status));
  const releasing = workers.filter(w => online(w) && w.activeAttempts?.length);
  const worker = ready.find(w => !releasing.some(r => r.id === w.id || r.deployment.resourceIds.some((id: string) => w.deployment.resourceIds.includes(id))) && !busy.some(j => j.workerId === w.id ||
    (j.resourceIds || []).some((r: string) => w.deployment.resourceIds.includes(r))));
  return { worker, reason: worker ? null : ready.length ? 'resource_busy' : 'model_offline',
    stage: worker ? '准备执行' : ready.length ? '排队：执行资源忙碌' : '模型离线：等待指定执行规格' };
}

/** Explicit dependency graph only. Canvas edges never reach this function implicitly. */
export function validateGraph(tasks: any[], mode: string) {
  if (!['batch', 'workflow'].includes(mode) || !Array.isArray(tasks) || !tasks.length || tasks.length > 100)
    throw new AppError('invalid_batch', '批量任务应为 1–100 个');
  const map = new Map(tasks.map(t => [t.key, t]));
  if (map.size !== tasks.length || tasks.some(t => typeof t.key !== 'string' || !/^[\w-]{1,80}$/.test(t.key))) throw new AppError('invalid_graph', '任务标识重复或无效');
  const done = new Set(), visiting = new Set();
  function visit(key: string) {
    if (visiting.has(key)) throw new AppError('dependency_cycle', '流程存在循环依赖');
    if (done.has(key)) return;
    visiting.add(key);
    const t = map.get(key);
    if (!Array.isArray(t.bindings || [])) throw new AppError('invalid_binding', '依赖绑定无效');
    if (mode === 'batch' && t.bindings?.length) throw new AppError('invalid_batch', '独立批量任务不能包含依赖');
    for (const b of t.bindings || []) {
      if (!map.has(b.from) || !/^(text|prompt|assetId|referenceAssetIds\.\d+|references\.\d+\.assetId|speaker\.assetId|emotionReference\.assetId)$/.test(b.target))
        throw new AppError('invalid_binding', '上游任务或输入位置无效');
      visit(b.from);
    }
    const targets = (t.bindings || []).map((b: any) => b.target);
    if (new Set(targets).size !== targets.length) throw new AppError('invalid_binding', '同一个输入不能绑定多个上游');
    visiting.delete(key); done.add(key);
  }
  for (const key of map.keys()) visit(key);
}
export function bindInput(input: any, target: string, value: string) {
  const parts = target.split('.'); let current = input;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object') throw new AppError('invalid_binding', '请先配置参考素材槽位');
    current = current[part];
  }
  current[parts.at(-1)!] = value;
}
export const isPending = (j: any) => !terminal.has(j.status);
