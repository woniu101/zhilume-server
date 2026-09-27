import { AppError } from './domain.js';
import { availableProfiles, validateIdentity } from './execution.js';
import { languageOperations, validateLanguageInput } from './language-request.js';

export function validateLanguageProfiles(profiles: any[]) {
  if (profiles.length > 8) throw new AppError('invalid_specs', '语言模型规格过多');
  return profiles.map(p => {
    validateIdentity(p);
    if (p.backend !== 'llama.cpp' || p.workflowRevision !== 'language.llamacpp.v1' || typeof p.modelId !== 'string' || !p.modelId || p.modelId.length > 160 ||
        !Array.isArray(p.operations) || p.operations.length !== 2 || !languageOperations.every(o => p.operations.includes(o)) ||
        JSON.stringify(p.capabilities) !== '["text"]' || JSON.stringify(p.outputFormats) !== '["txt"]' || p.maxImages !== 0 ||
        !Number.isInteger(p.maxInputCharacters) || p.maxInputCharacters < 1 || p.maxInputCharacters > 12000 ||
        !Number.isInteger(p.maxOutputTokens) || p.maxOutputTokens < 16 || p.maxOutputTokens > 4096 ||
        !Number.isInteger(p.contextSize) || p.contextSize < 2048 || p.contextSize > 32768)
      throw new AppError('invalid_language_spec', 'Worker 语言模型规格无效');
    return structuredClone(p);
  });
}
export function workerLanguageModels(workers: any[]) {
  const ids = [...new Set(workers.flatMap(w => (w.languageProfiles || []).map((p: any) => p.modelId)))];
  return ids.flatMap(id => availableProfiles(workers, 'languageProfiles', id as string).map(p => ({ ...p, name: p.modelId, providerName: 'GPU Worker', executor: 'worker', ready: p.readyCount > 0, defaults: [] })));
}
export function validateWorkerLanguage(operation: string, b: any, workers: any[], lookup: (id: string) => any) {
  const p = workerLanguageModels(workers).find(p => p.profileId === b?.profileId);
  if (!p || !p.operations.includes(operation)) throw new AppError('invalid_model', '请选择已登记的 Worker 语言模型规格');
  return { ...validateLanguageInput(operation, b, p, lookup), workflowRevision: p.workflowRevision };
}
export function supportsLanguageJob(w: any, job: any) {
  if (!languageOperations.includes(job.operation)) return true;
  return (w.languageProfiles || []).some((p: any) => p.profileId === job.input.profileId && p.modelId === job.input.modelId && p.operations.includes(job.operation) && job.input.text.length <= p.maxInputCharacters);
}
