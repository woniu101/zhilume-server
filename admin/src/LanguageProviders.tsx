import { useEffect, useState } from 'react';
import { api } from './api';
export function LanguageProviders() {
  const [items, setItems] = useState<any[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const empty = { name: '', baseUrl: '', apiKey: '', model: '', revision: '', vision: false, structured: false, enabled: true, defaultText: true, defaultPrompt: true };
  const [form, setForm] = useState<any>(empty);
  const refresh = () => api('/language/providers').then(setItems, e => setError(e.message));
  useEffect(() => { void refresh(); }, []);
  const edit = (change: any) => setForm((v: any) => ({ ...v, ...change }));
  async function save() {
    setBusy(true); setError('');
    try {
      await api('/language/providers', 'POST', { id: form.id, name: form.name, baseUrl: form.baseUrl, apiKey: form.apiKey, enabled: form.enabled,
        models: [{ model: form.model, revision: form.revision || form.model, capabilities: ['text', ...(form.vision ? ['vision'] : []), ...(form.structured ? ['structured'] : [])] }, ...(form.models || []).slice(1)],
        defaults: { ...(form.defaultText ? { text: form.model } : {}), ...(form.defaultPrompt ? { general: form.model, qwen: form.model, h3: form.model } : {}) } });
      setForm(empty); await refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="panel"><h2>互联网语言模型</h2><p>Chat Completions 兼容协议。纯文本、图片理解和结构化输出须按服务实际能力声明；配置成功不等于推理已验证。</p>
    {error && <p role="alert">{error}</p>}
    {items.map(p => <article key={p.id}><strong>{p.name}</strong> · {p.enabled ? '已启用' : '已停用'} · {p.models.map((m: any) => m.name).join('、')}
      <button onClick={() => { const m = p.models[0]; setForm({ ...empty, ...p, model: m.model, revision: m.revision, apiKey: '', vision: m.capabilities.includes('vision'), structured: m.capabilities.includes('structured'), defaultText: !!p.defaults.text, defaultPrompt: !!p.defaults.general }); }}>编辑</button>
      <button onClick={() => api('/language/providers', 'POST', { ...p, enabled: !p.enabled }).then(refresh, e => setError(e.message))}>{p.enabled ? '停用' : '启用'}</button>
    </article>)}
    <form onSubmit={e => { e.preventDefault(); void save(); }} className="provider-form">
      <h3>{form.id ? '编辑服务' : '添加服务'}</h3>
      <label>名称<input required value={form.name} onChange={e => edit({ name: e.target.value })}/></label>
      <label>API 根地址<input required placeholder="https://provider.example/v1" value={form.baseUrl} onChange={e => edit({ baseUrl: e.target.value })}/></label>
      <label>API Key<input type="password" autoComplete="new-password" required={!form.id} placeholder={form.id ? '留空保留已保存密钥' : ''} value={form.apiKey} onChange={e => edit({ apiKey: e.target.value })}/></label>
      <label>模型标识<input required value={form.model} onChange={e => edit({ model: e.target.value })}/></label>
      <label>版本标识<input value={form.revision} onChange={e => edit({ revision: e.target.value })}/></label>
      {[['vision','图片理解'],['structured','JSON Schema 结构化输出'],['defaultText','默认文本生成'],['defaultPrompt','默认提示词优化']].map(([k,label]) => <label key={k}><input type="checkbox" checked={form[k]} onChange={e => edit({ [k]: e.target.checked })}/>{label}</label>)}
      <p className="muted">密钥只存于 Server 私有加密文件。生成不强制优化；Studio 仅在用户应用建议后替换原稿。</p>
      <button className="primary" disabled={busy}>保存配置</button><button type="button" onClick={() => setForm(empty)}>清空表单</button>
    </form>
  </section>;
}
