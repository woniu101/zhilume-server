import { AssetStorage } from "./AssetStorage";
import { LanguageProviders } from "./LanguageProviders";
import metadata from "../../package.json";
import catalog from "../../contracts/operation-catalog.json";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  Server,
  History,
  HardDrive,
  Settings,
  Plus,
  RefreshCw,
  ArrowUpRight,
  Activity,
  FolderOpen,
  LogOut,
} from "lucide-react";
import {
  api,
  connection,
  logout,
  restoreAdminSession,
  sizeLabel,
  statusLabel,
} from "./api";
import { Brand, ThemeButton, Login, Modal } from "./ui";
import "./base.css";
import "./style.css";

function App() {
  const [connected, setConnected] = useState(!!connection.token),
    [page, setPage] = useState("overview"),
    [stats, setStats] = useState<any>(null),
    [system, setSystem] = useState<any>(null),
    [workers, setWorkers] = useState<any[]>([]),
    [jobs, setJobs] = useState<any[]>([]),
    [assets, setAssets] = useState<any[]>([]),
    [projects, setProjects] = useState<any[]>([]),
    [editor, setEditor] = useState<any>(null),
    [probe, setProbe] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reachable, setReachable] = useState<boolean | null>(null);
  useEffect(() => {
    void restoreAdminSession()
      .then(() => {
        if (connection.token) setConnected(true);
      })
      .catch((e) => setError(e.message));
  }, []);
  async function refresh() {
    try {
      const values = await Promise.all([
        api("/stats"),
        api("/workers"),
        api("/jobs"),
        api("/assets"),
        api("/projects"),
        api("/system"),
      ]);
      setStats(values[0]);
      setWorkers(values[1]);
      setJobs(values[2]);
      setAssets(values[3]);
      setProjects(values[4]);
      setSystem(values[5]);
      setReachable(true);
    } catch (e) {
      setReachable(false);
      if ((e as any).status === 401) setConnected(false);
      else setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (!connected) return;
    let running = false;
    const poll = async () => {
      if (running) return;
      running = true;
      await refresh();
      running = false;
    };
    void poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [connected]);
  useEffect(() => {
    if (error) {
      const t = setTimeout(() => setError(""), 6000);
      return () => clearTimeout(t);
    }
  }, [error]);
  const navigation = [
    ["overview", "总览", LayoutDashboard],
    ["workers", "执行端", Server],
    ["language", "语言模型", Settings],
    ["jobs", "任务队列", History],
    ["assets", "素材存储", HardDrive],
    ["settings", "服务设置", Settings],
  ] as const;
  const online = workers.filter((w) => w.connected && !w.disabled).length;
  async function changeWorker(id: string, body: any) {
    try {
      await api(`/workers/${id}`, "PATCH", body);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function editWorker(worker?: any) {
    setEditor({
      id: worker?.id,
      name: worker?.name || "",
      address: worker?.address || "",
      credential: "",
    });
    setProbe(null);
  }
  async function submitWorker(testOnly: boolean) {
    setBusy(true);
    setError("");
    const body = { ...editor };
    if (!body.credential && body.id) delete body.credential;
    try {
      if (testOnly) setProbe(await api("/workers/probe", "POST", body));
      else {
        await api(
          body.id ? `/workers/${body.id}` : "/workers",
          body.id ? "PATCH" : "POST",
          body,
        );
        setEditor(null);
        await refresh();
      }
    } catch (e) {
      setProbe(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {!connected ? (
        <Login server connected={() => setConnected(true)} />
      ) : (
        <div className="admin-layout">
          <aside className="admin-sidebar">
            <Brand subtitle="SERVER" />
            <div className="admin-space">
              <span className="muted">工作空间</span>
              <strong>我的创作服务</strong>
              <small>
                <span className="dot" />
                {reachable === null
                  ? "正在连接 Server"
                  : reachable
                    ? "Server 运行中"
                    : "连接中断"}
              </small>
            </div>
            <nav>
              {navigation.map(([key, label, Icon]) => (
                <button
                  key={key}
                  className={page === key ? "active" : ""}
                  onClick={() => setPage(key)}
                >
                  <Icon size={17} />
                  {label}
                  {key === "jobs" && stats?.running > 0 && (
                    <span className="badge">{stats.running}</span>
                  )}
                </button>
              ))}
            </nav>
            <div className="admin-side-bottom">
              <div className="local-tag">
                <Server size={17} />
                <div>
                  Zhilume Server
                  <small>
                    v{system?.version || metadata.version} · 协议{" "}
                    {system?.protocolVersion || "—"}
                  </small>
                </div>
              </div>
              <div className="row spread">
                <ThemeButton />
                <button
                  className="icon-button"
                  title="断开管理连接"
                  onClick={() => {
                    logout();
                    setConnected(false);
                  }}
                >
                  <LogOut size={16} />
                </button>
              </div>
            </div>
          </aside>
          <main className="admin-main">
            <header className="admin-topbar">
              <span className="muted">
                工作空间{" "}
                <span style={{ margin: "0 14px", opacity: 0.5 }}>/</span>{" "}
                <span style={{ color: "var(--text)" }}>
                  {navigation.find((i) => i[0] === page)?.[1]}
                </span>
              </span>
              <span
                className="connection-pill"
                title="表示管理台与 Server 通信正常；Worker 在线状态请查看执行端列表。"
              >
                <span className="dot" />
                {reachable === null
                  ? "正在连接 Server"
                  : reachable
                    ? "已连接 Server"
                    : "Server 连接中断"}
              </span>
            </header>
            <div className="admin-content">
              <div className="admin-heading">
                <div>
                  <p className="eyebrow">ZHILUME / CONTROL CENTER</p>
                  <h1>
                    {page === "overview"
                      ? "创作服务，一目了然。"
                      : navigation.find((i) => i[0] === page)?.[1]}
                  </h1>
                  <p className="muted">
                    {page === "overview"
                      ? "管理算力与创作任务，让想法持续发生。"
                      : page === "workers"
                        ? "Server 主动连接执行端，无需 Server 公网入口。"
                        : page === "jobs"
                          ? "查看真实任务状态，处理失败、取消和重试。"
                          : page === "assets"
                            ? "Server 统一保管上传素材和已确认的任务结果。"
                            : page === "language"
                              ? "接入互联网 API 与 Worker 语言模型，管理能力和默认用途。"
                              : "查看服务版本、数据位置与诊断信息。"}
                  </p>
                </div>
                <div className="row">
                  <button
                    title="刷新"
                    className="icon-button"
                    onClick={() => void refresh()}
                  >
                    <RefreshCw size={17} />
                  </button>
                  {["overview", "workers"].includes(page) && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => editWorker()}
                    >
                      <Plus size={15} />
                      接入执行端
                    </button>
                  )}
                </div>
              </div>
              {page === "overview" && (
                <>
                  <div className="metric-grid">
                    <Metric
                      label="在线执行端"
                      value={online}
                      detail={`${workers.length} 个已登记执行端`}
                      Icon={Server}
                    />
                    <Metric
                      label="进行中任务"
                      value={stats?.running ?? "—"}
                      detail={`${stats?.queued ?? 0} 个等待执行`}
                      Icon={Activity}
                    />
                    <Metric
                      label="素材存储"
                      value={stats ? sizeLabel(stats.bytes) : "—"}
                      detail={`${stats?.assets ?? 0} 个已归档文件`}
                      Icon={HardDrive}
                    />
                    <Metric
                      label="创作项目"
                      value={stats?.projects ?? "—"}
                      detail="未归档项目"
                      Icon={FolderOpen}
                    />
                  </div>
                  <section className="admin-card">
                    <div className="card-heading">
                      <h2>执行端</h2>
                      <button
                        className="text-button"
                        onClick={() => setPage("workers")}
                      >
                        查看全部
                        <ArrowUpRight size={14} />
                      </button>
                    </div>
                    <WorkerTable
                      workers={workers}
                      change={changeWorker}
                      edit={editWorker}
                    />
                  </section>
                  <section className="admin-card">
                    <div className="card-heading">
                      <h2>最近任务</h2>
                      <button
                        className="text-button"
                        onClick={() => setPage("jobs")}
                      >
                        查看全部
                        <ArrowUpRight size={14} />
                      </button>
                    </div>
                    <JobTable
                      jobs={jobs.slice(0, 6)}
                      projects={projects}
                      changed={refresh}
                      fail={setError}
                    />
                  </section>
                </>
              )}
              {page === "workers" && (
                <section className="admin-card">
                  <div className="card-heading">
                    <h2>已登记执行端 · {workers.length}</h2>
                    <span className="muted">单执行端并发：1</span>
                  </div>
                  <WorkerTable
                    workers={workers}
                    change={changeWorker}
                    edit={editWorker}
                  />
                </section>
              )}
              {page === "jobs" && (
                <section className="admin-card">
                  <div className="card-heading">
                    <h2>最近 200 个任务</h2>
                    <span className="badge">
                      GPU / 语言模型 API / FFmpeg / 模拟
                    </span>
                  </div>
                  <JobTable
                    jobs={jobs}
                    projects={projects}
                    changed={refresh}
                    fail={setError}
                  />
                </section>
              )}
              {page === "assets" && (
                <AssetStorage assets={assets} stats={stats} />
              )}
              {page === "language" && <LanguageProviders />}
              {page === "settings" && (
                <section className="admin-card settings-card">
                  <div className="row spread">
                    <h2>服务信息</h2>
                    <button
                      onClick={() => {
                        const report = {
                          generatedAt: new Date().toISOString(),
                          system,
                          counts: {
                            workers: workers.length,
                            online,
                            assets: stats?.assets,
                            bytes: stats?.bytes,
                            running: stats?.running,
                            queued: stats?.queued,
                          },
                          workers: workers.map((w) => ({
                            id: w.id,
                            state: w.state,
                            connected: w.connected,
                            disabled: w.disabled,
                            draining: w.draining,
                          })),
                          jobs: jobs.map((j) => ({
                            id: j.id,
                            status: j.status,
                            operation: j.operation,
                          })),
                        };
                        const url = URL.createObjectURL(
                          new Blob([JSON.stringify(report, null, 2)], {
                            type: "application/json",
                          }),
                        );
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "zhilume-server-diagnostics.json";
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      }}
                    >
                      导出脱敏诊断
                    </button>
                  </div>
                  <dl>
                    <dt>Server 版本</dt>
                    <dd>{system?.version || metadata.version}</dd>
                    <dt>协议版本</dt>
                    <dd>{system?.protocolVersion || "—"}</dd>
                    <dt>数据目录</dt>
                    <dd>
                      <code>{stats?.dataDirectory || "—"}</code>
                    </dd>
                    <dt>访问凭证来源</dt>
                    <dd>
                      <code>
                        {stats?.tokenFile || "由 ZHILUME_TOKEN 环境变量提供"}
                      </code>
                    </dd>
                    <dt>当前连接</dt>
                    <dd>{connection.base || location.origin}</dd>
                    <dt>持久化</dt>
                    <dd>SQLite + Server 本地文件存储</dd>
                    <dt>执行能力</dt>
                    <dd>
                      GPU Worker、语言模型 API、Server FFmpeg 独立调度；FFmpeg
                      并发 1
                    </dd>
                  </dl>
                  <div className="divider" />
                  <p className="prose">
                    EXE
                    启动器负责本机服务进程与数据目录；管理台负责执行端、模型、任务和素材。终端启动后使用日志中的管理台地址，在相同环境和目录运行
                    npm run credential 获取凭证。关闭管理台不会停止服务。
                  </p>
                </section>
              )}
              <footer className="admin-footer">
                Zhilume Server <span>算力由你掌握，创作由你定义。</span>
              </footer>
            </div>
          </main>
        </div>
      )}
      {editor && (
        <Modal
          title={editor.id ? "编辑执行端连接" : "接入新执行端"}
          close={() => {
            if (!busy) setEditor(null);
          }}
        >
          <p className="prose">
            优先填写云平台分配的 HTTPS 服务根地址（不要带
            /management），也可使用局域网地址。该入口须允许 Server 直接访问 HTTP
            和 WebSocket；平台网页登录保护不能代替 Worker 接入密钥。Server
            无需公网入口。
          </p>
          <form
            className="worker-connection-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitWorker(false);
            }}
          >
            <label>
              执行端名称
              <input
                value={editor.name}
                placeholder="可选，默认使用 Worker 名称"
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
              />
            </label>
            <label>
              Worker 地址
              <input
                required
                type="url"
                value={editor.address}
                placeholder="https://云平台分配的服务域名"
                onChange={(e) => {
                  setEditor({ ...editor, address: e.target.value });
                  setProbe(null);
                }}
              />
            </label>
            <label>
              接入密钥
              <input
                required={!editor.id}
                type="password"
                autoComplete="new-password"
                value={editor.credential}
                placeholder={
                  editor.id ? "留空保留现有密钥" : "填写 Worker 提供的接入密钥"
                }
                onChange={(e) => {
                  setEditor({ ...editor, credential: e.target.value });
                  setProbe(null);
                }}
              />
            </label>
            {probe && (
              <p className="prose" role="status">
                HTTP 校验通过，保存后建立 WebSocket：{probe.workerName} ·{" "}
                {probe.platform} · 协议 {probe.protocolVersion}
              </p>
            )}
            <div className="row">
              <button
                type="button"
                disabled={busy}
                onClick={() => void submitWorker(true)}
              >
                测试连接
              </button>
              <button className="primary" disabled={busy} type="submit">
                {busy ? "正在连接…" : "保存连接"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {error && (
        <div className="toast" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
function Metric({
  label,
  value,
  detail,
  Icon,
}: {
  label: string;
  value: any;
  detail: string;
  Icon: any;
}) {
  return (
    <article className="metric">
      <div className="row spread">
        <span>{label}</span>
        <Icon size={17} />
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <Server size={30} strokeWidth={1} />
      <span>{text}</span>
    </div>
  );
}
function WorkerTable({
  workers,
  change,
  edit,
}: {
  workers: any[];
  change: (id: string, body: any) => Promise<void>;
  edit: (worker: any) => void;
}) {
  if (!workers.length)
    return <Empty text="尚未接入执行端。点击“接入执行端”添加第一个 Worker。" />;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>执行端</th>
            <th>状态</th>
            <th>系统 / 能力</th>
            <th>最近心跳</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((w) => (
            <tr key={w.id}>
              <td>
                <div className="row">
                  <span className="worker-icon">
                    <Server size={17} />
                  </span>
                  <div>
                    <strong>{w.name}</strong>
                    <small>{w.address || w.id.slice(0, 8)}</small>
                  </div>
                </div>
              </td>
              <td>
                <span
                  className={`state-pill ${w.connected && !w.disabled ? "online" : ""}`}
                >
                  {w.disabled
                    ? "已停用"
                    : w.draining
                      ? "排空中"
                      : w.state === "busy"
                        ? "忙碌"
                        : w.state === "ready"
                          ? "在线"
                          : "离线"}
                </span>
              </td>
              <td>
                {w.platform}
                <small>{w.reason}</small>
                {w.lastError && (
                  <small className="job-error">{w.lastError}</small>
                )}
                {(w.activeJobs || []).map((j: any) => (
                  <small key={j.id}>
                    任务 {j.id.slice(0, 8)} · {j.stage}
                  </small>
                ))}
                <small>{w.capabilities.length} 项执行能力</small>
                {(w.imageProfiles || []).map((p: any) => (
                  <small key={p.profileId}>
                    {p.modelId} · {p.profileId.slice(0, 8)} · GPU 待验收
                  </small>
                ))}
              </td>
              <td>
                {w.lastHeartbeat
                  ? new Date(w.lastHeartbeat).toLocaleTimeString()
                  : "尚未握手"}
                {w.heartbeatAgeSeconds !== null && (
                  <small>{w.heartbeatAgeSeconds} 秒前</small>
                )}
              </td>
              <td>
                <div className="row">
                  <button className="small" onClick={() => edit(w)}>
                    连接设置
                  </button>
                  <button
                    className="small"
                    disabled={w.disabled}
                    onClick={() => void change(w.id, { draining: !w.draining })}
                  >
                    {w.draining ? "恢复接单" : "排空"}
                  </button>
                  <button
                    className="small"
                    onClick={() => void change(w.id, { disabled: !w.disabled })}
                  >
                    {w.disabled ? "启用" : "停用"}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function JobTable({
  jobs,
  projects,
  changed,
  fail,
}: {
  jobs: any[];
  projects: any[];
  changed: () => Promise<void>;
  fail: (s: string) => void;
}) {
  if (!jobs.length)
    return (
      <Empty text="暂无任务。在 Studio 选择节点，提交创作或媒体处理任务。" />
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>任务</th>
            <th>项目</th>
            <th>状态</th>
            <th>进度 / 阶段</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>
                <strong>
                  {[
                    ...catalog.imageOperations,
                    ...catalog.speechOperations,
                    ...catalog.media,
                  ].find((op) => op.id === j.operation)?.name ||
                    (j.operation === "mock.text.echo.v1"
                      ? "文本回显"
                      : j.operation === "mock.media.copy.v1"
                        ? "素材复制"
                        : j.operation)}
                </strong>
                <small>
                  {j.id.slice(0, 8)} ·{" "}
                  {j.simulation
                    ? "模拟"
                    : j.operation === "audio.speech.v1"
                      ? "GPU 语音"
                      : j.operation.startsWith("image.")
                        ? "GPU 图片"
                        : "CPU 处理"}
                </small>
              </td>
              <td>
                {projects.find((p) => p.id === j.projectId)?.name ||
                  j.projectId.slice(0, 8)}
              </td>
              <td>
                <span className="state-pill">{statusLabel[j.status]}</span>
              </td>
              <td title={j.error || ""}>
                {j.progress !== null
                  ? `${Math.round(j.progress * 100)}% · `
                  : ""}
                {j.stage}
                {j.error && <small className="job-error">{j.error}</small>}
                {j.workerId && (
                  <small>
                    执行端 {j.workerId.slice(0, 8)} · 尝试{" "}
                    {j.attemptId?.slice(0, 8)}
                  </small>
                )}
              </td>
              <td>
                {["failed", "interrupted"].includes(j.status) ? (
                  <button
                    className="small"
                    onClick={() =>
                      void api(`/jobs/${j.id}/retry`, "POST")
                        .then(changed)
                        .catch((e) => fail(e.message))
                    }
                  >
                    重试
                  </button>
                ) : !["succeeded", "cancelled"].includes(j.status) ? (
                  <button
                    className="small"
                    disabled={j.status === "cancel_requested"}
                    onClick={() =>
                      void api(`/jobs/${j.id}/cancel`, "POST")
                        .then(changed)
                        .catch((e) => fail(e.message))
                    }
                  >
                    取消
                  </button>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
