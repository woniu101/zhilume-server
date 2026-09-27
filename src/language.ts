import { h3Rules, promptRulesRevision } from './prompt-rules.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Ajv } from 'ajv';
import { AppError, id, text, terminal } from './domain.js';
import { fingerprint } from './execution.js';
import type { Store } from './store.js';
import type { Assets } from './assets.js';

export const languageOperations = ['text.generate.v1', 'prompt.optimize.v1'];
const rules: Record<string, string> = {
  general: 'Improve clarity and specificity while preserving the author intent and language. Do not invent requirements. Return only the proposed prompt.',
  qwen: 'Write a precise image generation or instruction-editing prompt. Separate what changes from what must remain. Preserve named subjects, reference order, exact quoted text, composition and aspect constraints. Do not invent references. Return only the proposed prompt.',
};
export class LanguageService {
  private key: Buffer;
  private secrets: Record<string, string>;
  private active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private closing = false;
  constructor(private store: Store, private assets: Assets, private changed: (j: any) => void) {
    const keyPath = join(store.root, 'language-vault.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    const path = join(store.root, 'language-vault.enc');
    this.secrets = {};
    if (existsSync(path)) {
      const data = readFileSync(path), decrypt = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      decrypt.setAuthTag(data.subarray(12, 28));
      this.secrets = JSON.parse(Buffer.concat([decrypt.update(data.subarray(28)), decrypt.final()]).toString());
    }
    for (const j of store.all('job')) if (j.executor === 'api' && ['assigned', 'running', 'cancel_requested'].includes(j.status)) {
      Object.assign(j, { status: 'interrupted', stage: 'Server 已重启', error: '请求结果未知，请确认后手动重试' }); changed(j);
    }
  }
  private saveSecrets() {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(this.secrets)), cipher.final()]);
    const path = join(this.store.root, 'language-vault.enc');
    writeFileSync(path + '.tmp', Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), { mode: 0o600 }); renameSync(path + '.tmp', path);
  }
  providers() { return this.store.all('language-provider').map(p => ({ ...p, hasKey: !!this.secrets[p.id] })); }
  configure(b: any) {
    const previous = b.id ? this.store.get('language-provider', b.id) : null;
    let url: URL; try { url = new URL(text(b.baseUrl, 2048)); } catch { throw new AppError('invalid_endpoint', '服务地址格式无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      throw new AppError('invalid_endpoint', '服务地址须为 HTTPS（本机测试可用 HTTP），不能包含凭证或查询参数');
    if (!Array.isArray(b.models) || !b.models.length || b.models.length > 32) throw new AppError('invalid_models', '请配置 1–32 个模型');
    const providerId = previous?.id || id();
    const models = b.models.map((m: any) => {
      const capabilities = [...new Set(m.capabilities || [])];
      if (!capabilities.includes('text') || capabilities.some(c => !['text', 'vision', 'structured'].includes(c as string)))
        throw new AppError('invalid_capabilities', '语言模型须声明文本能力，可选图片理解和结构化输出');
      const model = { model: text(m.model, 160), name: text(m.name || m.model, 160), revision: text(m.revision || m.model, 160), capabilities,
        maxInputCharacters: Number(m.maxInputCharacters || 12000), maxImages: Number(m.maxImages ?? 4) };
      if (!Number.isInteger(model.maxInputCharacters) || model.maxInputCharacters < 1 || model.maxInputCharacters > 20000 || !Number.isInteger(model.maxImages) || model.maxImages < 0 || model.maxImages > 8)
        throw new AppError('invalid_limits', '输入长度或图片数量无效');
      return { ...model, profileId: fingerprint({ providerId, protocol: 'chat-completions', baseUrl: url.href.replace(/\/$/, ''), ...model }) };
    });
    if (new Set(models.map((m: any) => m.profileId)).size !== models.length) throw new AppError('duplicate_model', '模型规格重复');
    const defaults = b.defaults || {};
    for (const purpose of Object.keys(defaults)) if (!['text', 'general', 'qwen', 'h3'].includes(purpose) || !models.some((m: any) => m.model === defaults[purpose])) throw new AppError('invalid_default', '默认用途必须指向当前服务的模型');
    if (b.apiKey !== undefined && b.apiKey !== '') { this.secrets[providerId] = text(b.apiKey, 8192); this.saveSecrets(); }
    if (!this.secrets[providerId]) throw new AppError('missing_key', '请设置 API Key');
    const provider = { id: providerId, name: text(b.name, 100), baseUrl: url.href.replace(/\/$/, ''), protocol: 'chat-completions', enabled: b.enabled !== false, models, defaults, concurrency: 1 };
    this.store.atomic(() => {
      // A purpose has one default across all services, without changing execution specs.
      for (const other of this.store.all('language-provider')) if (other.id !== providerId) {
        const next = { ...other.defaults };
        for (const purpose of Object.keys(defaults)) delete next[purpose];
        this.store.put('language-provider', { ...other, defaults: next });
      }
      this.store.put('language-provider', provider);
      for (const m of models) this.store.put('language-spec', { ...m, id: m.profileId, providerId, baseUrl: provider.baseUrl, protocol: provider.protocol });
    });
    return this.providers().find(p => p.id === providerId);
  }
  models() { return this.providers().flatMap(p => p.models.map((m: any) => ({ ...m, providerId: p.id, providerName: p.name, ready: p.enabled && p.hasKey, defaults: Object.keys(p.defaults).filter(k => p.defaults[k] === m.model) }))); }
  validate(operation: string, b: any, lookup = (assetId: string) => this.store.get('asset', assetId)) {
    const spec = this.store.get('language-spec', b?.profileId);
    if (!spec || !languageOperations.includes(operation)) throw new AppError('invalid_model', '请选择已配置的语言模型');
    const content = text(b.text, spec.maxInputCharacters);
    const references = b.referenceAssetIds || [];
    if (!Array.isArray(references) || references.length > spec.maxImages || new Set(references).size !== references.length || (references.length && !spec.capabilities.includes('vision'))) throw new AppError('unsupported_vision', '此规格不支持这些图片输入');
    for (const aId of references) { const a = lookup(aId); if (!a || a.staged || a.kind !== 'image' || a.size > 8 * 1024 ** 2) throw new AppError('invalid_reference', '图片须已归档且不超过 8 MB'); }
    if (b.schema) {
      if (!spec.capabilities.includes('structured') || JSON.stringify(b.schema).length > 16000) throw new AppError('unsupported_structure', '此规格不支持结构化输出');
      try { new Ajv({ strict: false }).compile(b.schema); } catch { throw new AppError('invalid_schema', 'JSON Schema 无效'); }
    }
    const purpose = operation === 'prompt.optimize.v1' ? b.purpose || 'general' : 'text';
    if (operation === 'prompt.optimize.v1' && !['general', 'qwen', 'h3'].includes(purpose)) throw new AppError('invalid_purpose', '提示词规则不存在');
    let context = null;
    if (purpose === 'h3' && b.context) {
      if (!['text','first','last','first-last','reference'].includes(b.context.mode) || !Number.isFinite(b.context.duration) || b.context.duration < 0 || b.context.duration > 15 || typeof b.context.includeAudio !== 'boolean') throw new AppError('invalid_context', 'H3 提示词约束无效');
      context = { mode: b.context.mode, duration: b.context.duration, includeAudio: b.context.includeAudio };
    }
    return { profileId: spec.id, modelId: spec.model, text: content, referenceAssetIds: references, schema: b.schema || null, purpose, context, rulesRevision: promptRulesRevision };
  }
  cancel(jobId: string) { this.active.get(jobId)?.abort.abort(); }
  pump() {
    if (this.closing) return;
    for (const j of this.store.all('job').reverse().filter(j => j.executor === 'api' && j.status === 'queued')) {
      const spec = this.store.get('language-spec', j.input.profileId), provider = spec && this.store.get('language-provider', spec.providerId);
      if (!provider?.enabled || !this.secrets[provider.id]) { if (j.waitReason !== 'model_offline') this.changed(Object.assign(j, { waitReason: 'model_offline', stage: '语言模型服务已停用' })); continue; }
      if (this.active.size >= 2 || [...this.active.keys()].some(k => this.store.get('job', k)?.providerId === provider.id)) {
        if (j.waitReason !== 'resource_busy') this.changed(Object.assign(j, { waitReason: 'resource_busy', stage: '等待互联网模型队列' })); continue;
      }
      const abort = new AbortController();
      Object.assign(j, { status: 'running', stage: '语言模型处理中', waitReason: null, providerId: provider.id }); this.changed(j);
      const done = this.run(j, spec, abort).finally(() => { this.active.delete(j.id); this.pump(); });
      this.active.set(j.id, { abort, done });
    }
  }
  private async run(job: any, spec: any, abort: AbortController) {
    const timer = setTimeout(() => abort.abort(new Error('timeout')), 120000);
    try {
      const input = job.input, parts: any[] = [{ type: 'text', text: input.text }];
      for (const assetId of input.referenceAssetIds) {
        const asset = this.store.get('asset', assetId), bytes = await readFile(this.assets.path(asset));
        parts.push({ type: 'image_url', image_url: { url: `data:${asset.mimeType};base64,${bytes.toString('base64')}` } });
      }
      const response = await fetch(spec.baseUrl + '/chat/completions', {
        method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.secrets[spec.providerId] },
        body: JSON.stringify({ model: spec.model, stream: false, messages: [
          { role: 'system', content: input.purpose === 'text' ? 'Follow the user request. Return the requested text only.' : input.purpose === 'h3' ? h3Rules(input.context) : rules[input.purpose] },
          { role: 'user', content: parts.length === 1 ? input.text : parts },
        ], ...(input.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: input.schema } } } : {}) }),
      });
      if (!response.ok) throw new AppError('provider_error', `语言模型服务返回 HTTP ${response.status}`);
      // Bound provider output before parsing; never persist raw error responses or headers.
      let raw = ''; const decoder = new TextDecoder();
      for await (const chunk of response.body as any) { raw += decoder.decode(chunk, { stream: true }); if (raw.length > 256000) { abort.abort(); throw new AppError('output_too_large', '语言模型响应过大'); } }
      raw += decoder.decode(); const result = JSON.parse(raw);
      const content = text(result.choices?.[0]?.message?.content, 12000);
      if (result.choices?.[0]?.finish_reason !== 'stop') throw new AppError('incomplete_output', '语言模型未完整输出，请调整输入后重试');
      if (input.schema && !new Ajv({ strict: false }).compile(input.schema)(JSON.parse(content))) throw new AppError('invalid_output', '输出不符合 JSON Schema');
      const asset = await this.assets.ingest(Readable.from([Buffer.from(content)]), '语言模型结果.txt', { staged: true, jobId: job.id, attemptId: job.attemptId });
      const current = this.store.get('job', job.id);
      if (abort.signal.aborted || current.status === 'cancel_requested') throw new Error('cancelled');
      this.store.atomic(() => {
        this.store.put('asset', { ...asset, staged: false });
        this.changed(Object.assign(current, { status: 'succeeded', stage: '结果已归档', progress: 1, outputAssetId: asset.id, outputText: content }));
      });
    } catch (error) {
      const current = this.store.get('job', job.id);
      if (current && !terminal.has(current.status)) this.changed(Object.assign(current, {
        status: current.status === 'cancel_requested' ? 'cancelled' : 'failed', stage: current.status === 'cancel_requested' ? '已取消本地请求' : '语言模型请求失败',
        error: error instanceof AppError ? error.message : '请求未完成，请检查服务配置或重试；原稿未改变', errorCode: error instanceof AppError ? error.code : 'provider_request_failed',
      }));
    } finally { clearTimeout(timer); }
  }
  async close() { this.closing = true; for (const a of this.active.values()) a.abort.abort(); await Promise.all([...this.active.values()].map(a => a.done)); }
}
