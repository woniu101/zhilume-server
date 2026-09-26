import { readFileSync } from "node:fs";
import { AppError, requireValue, text } from "./domain.js";
const catalog = JSON.parse(readFileSync(new URL("../contracts/operation-catalog.json", import.meta.url), "utf8"));
export const imageModels: any[] = catalog.imageModels;
export const imageCapabilities: any[] = catalog.imageOperations;
export const isImageOperation = (operation: string) => imageCapabilities.some(c => c.id === operation);
export const online = (w: any) => w.connected && !w.disabled && !w.draining && Date.now() - w.lastHeartbeat < 40000;

export function validateImageProfiles(value: unknown): any[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new AppError("invalid_profiles", "图片执行配置无效");
  const seen = new Set();
  return value.map(p => {
    const model = imageModels.find(m => m.id === p?.modelId);
    if (!model || typeof p.profileId !== "string" || !/^[a-f0-9]{64}$/.test(p.profileId) || seen.has(p.profileId) ||
        p.workflowRevision !== model.workflowRevision || !Array.isArray(p.operations) || !p.operations.length ||
        p.operations.some((op: any) => !model.operations.includes(op)) ||
        !Number.isInteger(p.maxReferences) || p.maxReferences < 0 || p.maxReferences > 16 ||
        (p.modelId === "qwen-image-2512" && p.maxReferences !== 0) ||
        !Array.isArray(p.formats) || !p.formats.length || p.formats.some((f: any) => !model.formats.includes(f)) ||
        p.minSize !== 256 || !Number.isInteger(p.maxSize) || p.maxSize < 512 || p.maxSize > 2048 || p.maxSize % 32 || p.sizeStep !== 32 ||
        !Number.isInteger(p.referenceResolution) || p.referenceResolution < 256 || p.referenceResolution > 2048 || p.referenceResolution % 32 ||
        !Number.isInteger(p.defaultSteps) || p.defaultSteps < 1 || p.defaultSteps > 100 ||
        p.maxSteps !== 100 || p.validation !== "unverified")
      throw new AppError("invalid_profiles", "图片执行配置与模型契约不一致");
    seen.add(p.profileId);
    return { modelId: p.modelId, profileId: p.profileId, workflowRevision: p.workflowRevision, operations: [...new Set(p.operations)],
      maxReferences: p.maxReferences, formats: [...new Set(p.formats)], minSize: p.minSize, maxSize: p.maxSize, sizeStep: p.sizeStep,
      referenceResolution: p.referenceResolution, defaultSteps: p.defaultSteps, maxSteps: p.maxSteps, validation: p.validation };
  });
}
export function modelAvailability(workers: any[]) {
  return imageModels.map(model => {
    const profiles = [...new Map(workers.filter(online).flatMap(w => w.imageProfiles || []).filter(p => p.modelId === model.id).map(p => [p.profileId, p])).values()];
    return { ...model, profiles, ready: profiles.length > 0 };
  });
}
export function validateImageInput(operation: string, b: any, workers: any[], lookup: (id: string) => any) {
  const model = imageModels.find(m => m.id === b?.modelId);
  if (!model?.operations.includes(operation)) throw new AppError("invalid_model", "该模型不支持所选操作");
  const profile: any = modelAvailability(workers).find(m => m.id === model.id)!.profiles.find((p: any) => p.profileId === b.profileId);
  if (!profile || profile.workflowRevision !== b.workflowRevision || !profile.operations.includes(operation))
    throw new AppError("model_unavailable", "该模型执行配置已离线或变更，请刷新后重试", 409);
  const refs = b.referenceAssetIds;
  const minRefs = operation === "image.generate.v1" ? 0 : operation === "image.edit.v1" ? 1 : 2;
  const maxRefs = operation === "image.generate.v1" ? 0 : operation === "image.edit.v1" ? 1 : profile.maxReferences;
  if (!Array.isArray(refs) || refs.length < minRefs || refs.length > maxRefs || new Set(refs).size !== refs.length)
    throw new AppError("invalid_references", `此操作需要 ${minRefs === maxRefs ? minRefs : `${minRefs}–${maxRefs}`} 张不同的参考图`);
  for (const id of refs) {
    const asset = requireValue(lookup(text(id, 100)), "参考素材不存在");
    if (asset.kind !== "image" || asset.staged || asset.size > 64 * 1024 ** 2) throw new AppError("invalid_references", "参考素材必须为已归档、64 MB 以内的图片");
  }
  const prompt = text(b.prompt, 12000);
  if (typeof b.negativePrompt !== "string" || b.negativePrompt.length > 12000) throw new AppError("invalid_input", "反向提示词格式无效");
  if (!profile.formats.includes(b.outputFormat) || !Number.isSafeInteger(b.seed) || b.seed < 0 || !Number.isInteger(b.steps) || b.steps < 1 || b.steps > profile.maxSteps)
    throw new AppError("invalid_parameters", "格式、步数或随机种子不受支持");
  const dimensions = operation === "image.generate.v1";
  if (dimensions ? [b.width, b.height].some(n => !Number.isInteger(n) || n < profile.minSize || n > profile.maxSize || n % profile.sizeStep) : b.width !== undefined || b.height !== undefined)
    throw new AppError("invalid_dimensions", dimensions ? "尺寸超出执行配置范围或不是 32 的倍数" : "参考编辑的尺寸跟随第一张参考图，请勿同时指定宽高");
  return { modelId: model.id, profileId: profile.profileId, workflowRevision: profile.workflowRevision, prompt, negativePrompt: b.negativePrompt,
    referenceAssetIds: refs, steps: b.steps, seed: b.seed, outputFormat: b.outputFormat,
    ...(dimensions ? { width: b.width, height: b.height } : { referenceResolution: profile.referenceResolution }) };
}
export function supportsImageJob(worker: any, job: any) {
  return !isImageOperation(job.operation) || (worker.imageProfiles || []).some((p: any) => p.profileId === job.input.profileId && p.modelId === job.input.modelId && p.workflowRevision === job.input.workflowRevision && p.operations.includes(job.operation));
}
