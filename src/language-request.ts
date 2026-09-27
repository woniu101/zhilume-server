import { Ajv } from 'ajv';
import { AppError, text } from './domain.js';
import { h3Rules, promptRulesRevision } from './prompt-rules.js';

export const languageOperations = ['text.generate.v1', 'prompt.optimize.v1'];
export function validateLanguageInput(operation: string, b: any, spec: any, lookup: (id: string) => any) {
  const content = text(b.text, spec.maxInputCharacters);
  const references = b.referenceAssetIds || [];
  if (!Array.isArray(references) || references.length > spec.maxImages || new Set(references).size !== references.length || (references.length && !spec.capabilities.includes('vision')))
    throw new AppError('unsupported_vision', '此规格不支持这些图片输入');
  for (const id of references) { const a = lookup(id); if (!a || a.staged || a.kind !== 'image' || a.size > 8 * 1024 ** 2) throw new AppError('invalid_reference', '图片须已归档且不超过 8 MB'); }
  if (b.schema) {
    if (!spec.capabilities.includes('structured') || JSON.stringify(b.schema).length > 16000) throw new AppError('unsupported_structure', '此规格不支持结构化输出');
    if (spec.structuredMode === 'json_object' && b.schema.type !== 'object') throw new AppError('unsupported_structure', 'JSON 对象模式要求顶层 Schema 为 object');
    try { new Ajv({ strict: false }).compile(b.schema); } catch { throw new AppError('invalid_schema', 'JSON Schema 无效'); }
  }
  const purpose = operation === 'prompt.optimize.v1' ? b.purpose || 'general' : 'text';
  if (!['text', 'general', 'qwen', 'h3'].includes(purpose) || (operation === 'prompt.optimize.v1' && purpose === 'text')) throw new AppError('invalid_purpose', '提示词规则不存在');
  let context = null;
  if (purpose === 'qwen' && b.context) {
    if (!['image.generate.v1','image.edit.v1','image.reference.v1'].includes(b.context.operation)) throw new AppError('invalid_context','图片操作类型无效');
    context = { operation: b.context.operation };
  }
  if (purpose === 'h3' && b.context) {
    if (!['text','first','last','first-last','reference'].includes(b.context.mode) || !Number.isFinite(b.context.duration) || b.context.duration < 0 || b.context.duration > 15 || typeof b.context.includeAudio !== 'boolean') throw new AppError('invalid_context', 'H3 提示词约束无效');
    context = { mode: b.context.mode, duration: b.context.duration, includeAudio: b.context.includeAudio };
  }
  const input = { profileId: spec.profileId || spec.id, modelId: spec.modelId || spec.model, text: content, referenceAssetIds: references, schema: b.schema || null, purpose, context, rulesRevision: promptRulesRevision };
  return { ...input, systemPrompt: systemPrompt(input) };
}

export function systemPrompt(input: any) {
  const rules: Record<string, string> = {
    text: 'Follow the user request. Return the requested text only.',
    general: 'Improve clarity and specificity while preserving the author intent and language. Do not invent requirements. Return only the proposed prompt.',
    qwen: 'Write a precise image generation or instruction-editing prompt. Separate what changes from what must remain. Preserve the author language. Preserve named subjects, reference order, exact quoted text, composition and aspect constraints. Do not invent references. Return only the proposed prompt.',
  };
  const parts = [input.purpose === 'h3' ? h3Rules(input.context) : rules[input.purpose]];
  if (input.purpose === 'qwen') {
    const operation = input.context?.operation;
    parts.push(operation === 'image.generate.v1'
      ? 'This is text-to-image generation without an original image. Describe the new image directly. Never instruct editing, removing or retaining properties of an existing image.'
      : operation ? 'Task operation: ' + operation
      : 'If no input image is explicitly supplied, describe a new image. Never assume an original image exists.');
    if (/[\u4e00-\u9fff]/.test(input.text)) parts.push('请用中文给出完整建议，不要翻译成英文；仅保留原稿已有的英文专名。');
  }
  if (input.schema) parts.push('Return a JSON object conforming to this JSON Schema: ' + JSON.stringify(input.schema));
  return parts.join('\n');
}

export function validateLanguageOutput(content: unknown, schema?: any) {
  const result = text(content, 12000);
  if (schema) {
    try { if (!new Ajv({ strict: false }).compile(schema)(JSON.parse(result))) throw Error(); }
    catch { throw new AppError('invalid_output', '输出不符合 JSON Schema'); }
  }
  return result;
}
