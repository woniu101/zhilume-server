import { useEffect, useState } from "react";
import { Plus, X, Server, Globe, RefreshCw } from "lucide-react";
import { api } from "./api";
const protocols: Record<string, string> = {
  "chat-completions": "Chat Completions",
  responses: "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};
const presets = [
  ["DeepSeek", "https://api.deepseek.com", "chat-completions", "国内服务"],
  [
    "阿里云百炼 / 通义千问",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "chat-completions",
    "国内服务",
  ],
  [
    "火山方舟 / 豆包",
    "https://ark.cn-beijing.volces.com/api/v3",
    "chat-completions",
    "国内服务",
  ],
  [
    "智谱 GLM",
    "https://open.bigmodel.cn/api/paas/v4",
    "chat-completions",
    "国内服务",
  ],
  [
    "Moonshot / Kimi",
    "https://api.moonshot.cn/v1",
    "chat-completions",
    "国内服务",
  ],
  ["MiniMax", "https://api.minimaxi.com/v1", "chat-completions", "国内服务"],
  ["OpenAI", "https://api.openai.com/v1", "responses", "国际服务"],
  [
    "Anthropic Claude",
    "https://api.anthropic.com/v1",
    "anthropic-messages",
    "国际服务",
  ],
  [
    "Google Gemini",
    "https://generativelanguage.googleapis.com/v1beta/openai",
    "chat-completions",
    "国际服务",
  ],
  ["自定义 / 自部署服务", "", "chat-completions", "自定义"],
];
const purposes = [
  ["text", "文本生成"],
  ["general", "通用提示词"],
  ["qwen", "图片提示词"],
  ["h3", "视频提示词"],
];
const newModel = () => ({
  model: "",
  name: "",
  revision: "",
  capabilities: ["text"],
  structuredMode: "json_schema",
  reasoningEffort: "default",
  maxOutputTokens: 2048,
  maxInputCharacters: 12000,
  maxImages: 4,
});
export function LanguageProviders() {
  const [items, setItems] = useState<any[]>([]),
    [workers, setWorkers] = useState<any[]>([]),
    [form, setForm] = useState<any>(null),
    [preset, setPreset] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [discovered, setDiscovered] = useState<any[]>([]);
  async function refresh() {
    try {
      const [p, m] = await Promise.all([
        api("/language/providers"),
        api("/language/models"),
      ]);
      setItems(p);
      setWorkers(m.filter((x: any) => x.executor === "worker"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!form) return;
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setForm(null);
      if (e.key === "Tab") {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".provider-dialog button:not(:disabled),.provider-dialog input:not(:disabled),.provider-dialog select:not(:disabled),.provider-dialog summary",
          ),
        ).filter((n) => n.getClientRects().length);
        const first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [form, busy]);
  const change = (v: any) => {
    setForm((p: any) => ({ ...p, ...v }));
    setNotice("");
  };
  function choose(p: string[]) {
    setPreset(p[0]);
    setForm({
      name: p[0],
      baseUrl: p[1],
      protocol: p[2],
      apiKey: "",
      enabled: true,
      models: [newModel()],
      defaults: {},
    });
    setDiscovered([]);
    setError("");
    setNotice("");
  }
  function modelChange(i: number, v: any) {
    change({
      models: form.models.map((m: any, j: number) =>
        j === i ? { ...m, ...v } : m,
      ),
    });
  }
  async function discover() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await api("/language/providers/discover", "POST", form);
      setDiscovered(r.models);
      setNotice(
        `接口可访问 · ${r.elapsedMs} ms · 获取 ${r.models.length} 个模型。未执行生成。`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api("/language/providers", "POST", form);
      setForm(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="language-page">
      <section className="admin-card">
        <div className="card-heading">
          <div>
            <h2>互联网与自部署 API</h2>
            <p className="muted">管理服务与模型，在 Studio 中选择使用。</p>
          </div>
          <button className="primary" onClick={() => choose(presets[0])}>
            <Plus size={16} />
            添加服务
          </button>
        </div>
        {!items.length ? (
          <div className="provider-empty">
            <Globe size={30} />
            <h3>接入你的第一个语言模型</h3>
            <p>
              选择服务商，填写 API Key
              和模型。生成与提示词优化可以使用不同模型。
            </p>
            <button onClick={() => choose(presets[0])}>选择服务商</button>
          </div>
        ) : (
          <div className="provider-list">
            {items.map((p) => (
              <article className="provider-card" key={p.id}>
                <div className="row spread">
                  <div>
                    <h3>{p.name}</h3>
                    <span className="muted">
                      {protocols[p.protocol]} ·{" "}
                      {p.enabled ? "已启用" : "已停用"} ·{" "}
                      {p.hasKey ? "密钥已保存" : "未配置密钥"}
                    </span>
                  </div>
                  <div className="row">
                    <button
                      onClick={() => {
                        setForm({
                          ...p,
                          apiKey: "",
                          models: p.models.map((m: any) => ({ ...m })),
                        });
                        setError("");
                        setNotice("");
                        setDiscovered([]);
                      }}
                    >
                      编辑
                    </button>
                    <button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await api("/language/providers", "POST", {
                            ...p,
                            enabled: !p.enabled,
                          });
                          await refresh();
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {p.enabled ? "停用" : "启用"}
                    </button>
                  </div>
                </div>
                <p className="muted endpoint-label">{p.baseUrl}</p>
                <div className="model-chips">
                  {p.models.map((m: any) => (
                    <span className="badge" key={m.profileId}>
                      {m.name} ·{" "}
                      {m.capabilities
                        .map(
                          (c: string) =>
                            (
                              ({
                                text: "文本",
                                vision: "图片理解",
                                structured: "结构化",
                              }) as Record<string, string>
                            )[c],
                        )
                        .join(" / ")}
                    </span>
                  ))}
                </div>
                <p className="muted">
                  {purposes
                    .filter(([k]) => p.defaults[k])
                    .map(([k, l]) => `${l}：${p.defaults[k]}`)
                    .join(" · ") || "未设为默认用途"}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>
      <section className="admin-card">
        <div className="card-heading">
          <div>
            <h2>
              <Server size={17} /> Worker 语言模型
            </h2>
            <p className="muted">
              在 Worker 面板配置并启用，Server 自动汇总，无需在此重复填写 API
              Key。
            </p>
          </div>
        </div>
        <div className="provider-list">
          {workers.length ? (
            workers.map((m) => (
              <article className="provider-card" key={m.profileId}>
                <strong>{m.name || m.modelId || m.model}</strong>
                <p className="muted">
                  {m.ready ? "可分配执行" : "当前离线"} · {m.endpointCount ?? 0}{" "}
                  个执行端
                </p>
              </article>
            ))
          ) : (
            <p className="muted">
              暂无 Worker 语言模型。请接入 Worker 并启用“通用语言模型”执行器。
            </p>
          )}
        </div>
      </section>
      {error && !form && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {form && (
        <div className="provider-backdrop">
          <section
            className="provider-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="语言模型服务配置"
          >
            <header className="provider-dialog-header">
              <div>
                <h2>{form.id ? "编辑语言模型服务" : "添加语言模型服务"}</h2>
                <span className="muted">
                  密钥保存在 Server，不进入项目或 Worker。
                </span>
              </div>
              <button
                aria-label="关闭接入面板"
                disabled={busy}
                onClick={() => setForm(null)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="provider-dialog-body">
              {!form.id && (
                <nav className="provider-presets" aria-label="服务商">
                  {["国内服务", "国际服务", "自定义"].map((g) => (
                    <div key={g}>
                      <small>{g}</small>
                      {presets
                        .filter((p) => p[3] === g)
                        .map((p) => (
                          <button
                            type="button"
                            key={p[0]}
                            disabled={busy}
                            className={preset === p[0] ? "active" : ""}
                            onClick={() => choose(p)}
                          >
                            <span>{p[0]}</span>
                            <small>{protocols[p[2]]}</small>
                          </button>
                        ))}
                    </div>
                  ))}
                </nav>
              )}
              <form
                id="provider-editor"
                className="provider-editor"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <fieldset disabled={busy}>
                  <h3>连接信息</h3>
                  <div className="field-grid">
                    <label>
                      服务名称
                      <input
                        autoFocus
                        required
                        value={form.name}
                        onChange={(e) => change({ name: e.target.value })}
                      />
                    </label>
                    <label>
                      接口协议
                      <select
                        value={form.protocol}
                        onChange={(e) => {
                          change({
                            protocol: e.target.value,
                            models: form.models.map((m: any) => ({
                              ...m,
                              structuredMode: "json_schema",
                              reasoningEffort: "default",
                            })),
                          });
                          setDiscovered([]);
                        }}
                      >
                        {Object.entries(protocols).map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="span-two">
                      API 根地址
                      <input
                        required
                        type="url"
                        placeholder="https://provider.example/v1"
                        value={form.baseUrl}
                        onChange={(e) => {
                          change({ baseUrl: e.target.value });
                          setDiscovered([]);
                        }}
                      />
                      <small>
                        按账号区域或套餐修改根地址，不必填写 /chat/completions
                        等末尾路径。
                      </small>
                    </label>
                    <label className="span-two">
                      API Key
                      <input
                        type="password"
                        autoComplete="new-password"
                        required={!form.id}
                        placeholder={
                          form.id
                            ? "留空保留原密钥；更换地址需重填"
                            : "粘贴此服务的 API Key"
                        }
                        value={form.apiKey}
                        onChange={(e) => change({ apiKey: e.target.value })}
                      />
                    </label>
                  </div>
                  <div className="row">
                    <button type="button" onClick={() => void discover()}>
                      <RefreshCw size={15} />
                      获取模型列表
                    </button>
                    <span className="muted">只查询目录，不运行生成</span>
                  </div>
                  {notice && (
                    <p role="status" className="provider-notice">
                      {notice}
                    </p>
                  )}
                  <div className="row spread section-label">
                    <h3>可用模型</h3>
                    <button
                      type="button"
                      disabled={form.models.length >= 32}
                      onClick={() =>
                        change({ models: [...form.models, newModel()] })
                      }
                    >
                      <Plus size={14} />
                      添加模型
                    </button>
                  </div>
                  <datalist id="discovered-models">
                    {discovered.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </datalist>
                  {form.models.map((m: any, i: number) => (
                    <section className="model-editor" key={i}>
                      <div className="field-grid">
                        <label>
                          模型标识
                          <input
                            required
                            list="discovered-models"
                            placeholder="选择或输入平台模型 ID"
                            value={m.model}
                            onChange={(e) => {
                              const defaults = { ...form.defaults };
                              for (const k of Object.keys(defaults))
                                if (defaults[k] === m.model)
                                  defaults[k] = e.target.value;
                              change({
                                models: form.models.map((x: any, j: number) =>
                                  i === j ? { ...x, model: e.target.value } : x,
                                ),
                                defaults,
                              });
                            }}
                          />
                        </label>
                        <label>
                          显示名称
                          <input
                            value={m.name || ""}
                            placeholder="可选，默认使用模型标识"
                            onChange={(e) =>
                              modelChange(i, { name: e.target.value })
                            }
                          />
                        </label>
                      </div>
                      <div className="row wrap">
                        <span className="badge">文本</span>
                        {[
                          ["vision", "图片理解"],
                          ["structured", "结构化输出"],
                        ].map(([cap, label]) => (
                          <label className="check-label" key={cap}>
                            <input
                              type="checkbox"
                              checked={m.capabilities.includes(cap)}
                              onChange={(e) =>
                                modelChange(i, {
                                  capabilities: e.target.checked
                                    ? [...m.capabilities, cap]
                                    : m.capabilities.filter(
                                        (x: string) => x !== cap,
                                      ),
                                })
                              }
                            />
                            {label}
                          </label>
                        ))}
                        <button
                          type="button"
                          className="text-button"
                          disabled={form.models.length === 1}
                          onClick={() =>
                            change({
                              models: form.models.filter(
                                (_: any, j: number) => i !== j,
                              ),
                              defaults: Object.fromEntries(
                                Object.entries(form.defaults).filter(
                                  ([, v]) => v !== m.model,
                                ),
                              ),
                            })
                          }
                        >
                          移除
                        </button>
                      </div>
                      <details>
                        <summary>高级参数</summary>
                        <div className="field-grid">
                          <label>
                            版本标识
                            <input
                              value={m.revision || ""}
                              placeholder="可选，固定版本便于追溯"
                              onChange={(e) =>
                                modelChange(i, { revision: e.target.value })
                              }
                            />
                          </label>
                          <label>
                            输出 Token 上限
                            <input
                              type="number"
                              min={16}
                              max={8192}
                              value={m.maxOutputTokens}
                              onChange={(e) =>
                                modelChange(i, {
                                  maxOutputTokens: +e.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            输入字符上限
                            <input
                              type="number"
                              min={1}
                              max={20000}
                              value={m.maxInputCharacters}
                              onChange={(e) =>
                                modelChange(i, {
                                  maxInputCharacters: +e.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            思考模式
                            <select
                              value={m.reasoningEffort}
                              onChange={(e) =>
                                modelChange(i, {
                                  reasoningEffort: e.target.value,
                                })
                              }
                            >
                              <option value="default">服务默认</option>
                              <option value="none">关闭（需模型支持）</option>
                              {form.protocol !== "anthropic-messages" && (
                                <>
                                  <option value="low">低</option>
                                  <option value="high">高</option>
                                </>
                              )}
                            </select>
                          </label>
                          {m.capabilities.includes("vision") && (
                            <label>
                              图片数量上限
                              <input
                                type="number"
                                min={1}
                                max={8}
                                value={m.maxImages}
                                onChange={(e) =>
                                  modelChange(i, { maxImages: +e.target.value })
                                }
                              />
                            </label>
                          )}
                          {m.capabilities.includes("structured") && (
                            <label>
                              结构化格式
                              <select
                                value={m.structuredMode}
                                onChange={(e) =>
                                  modelChange(i, {
                                    structuredMode: e.target.value,
                                  })
                                }
                              >
                                <option value="json_schema">JSON Schema</option>
                                {form.protocol === "chat-completions" && (
                                  <option value="json_object">
                                    JSON 对象 + Server 校验
                                  </option>
                                )}
                              </select>
                            </label>
                          )}
                        </div>
                      </details>
                    </section>
                  ))}
                  <h3 className="section-label">默认用途</h3>
                  <div className="field-grid">
                    {purposes.map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <select
                          aria-label={label}
                          value={form.defaults[key] || ""}
                          onChange={(e) => {
                            const d = { ...form.defaults };
                            if (e.target.value) d[key] = e.target.value;
                            else delete d[key];
                            change({ defaults: d });
                          }}
                        >
                          <option value="">不设为默认</option>
                          {form.models
                            .filter((m: any) => m.model)
                            .map((m: any, i: number) => (
                              <option key={i} value={m.model}>
                                {m.name || m.model}
                              </option>
                            ))}
                        </select>
                      </label>
                    ))}
                  </div>
                  <p className="muted">
                    能力选项须符合模型实际支持范围。保存配置和获取目录不代表真实推理已验证。
                  </p>
                </fieldset>
              </form>
            </div>
            <footer className="provider-dialog-footer">
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <div className="row">
                <button disabled={busy} onClick={() => setForm(null)}>
                  取消
                </button>
                <button
                  className="primary"
                  form="provider-editor"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? "正在处理…" : "保存服务"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
