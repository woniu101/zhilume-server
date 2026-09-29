import brandIcon from "../../assets/icon.svg";
import { useEffect, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun, X } from "lucide-react";
import { connection, login } from "./api";

export function ThemeButton() {
  const [mode, setMode] = useState(
    localStorage.getItem("zhilume.theme") || "dark",
  );
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        mode === "system" ? (query.matches ? "dark" : "light") : mode;
    };
    apply();
    localStorage.setItem("zhilume.theme", mode);
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [mode]);
  return (
    <button
      className="icon-button"
      title={`主题：${{ dark: "深色", light: "浅色", system: "跟随系统" }[mode]}（点击切换）`}
      aria-label="切换主题"
      onClick={() =>
        setMode(
          mode === "dark" ? "light" : mode === "light" ? "system" : "dark",
        )
      }
    >
      {mode === "dark" ? (
        <Moon size={17} />
      ) : mode === "light" ? (
        <Sun size={17} />
      ) : (
        <Monitor size={17} />
      )}
    </button>
  );
}
export function Brand({ subtitle = "STUDIO" }: { subtitle?: string }) {
  return (
    <div className="brand">
      <span className="brand-mark">
        <img src={brandIcon} width={30} height={30} alt="" />
      </span>
      <span>
        Zhilume <small>{subtitle}</small>
      </span>
    </div>
  );
}
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [close]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={close}>
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Login({
  connected,
  server = false,
}: {
  connected: () => void;
  server?: boolean;
}) {
  const [base, setBase] = useState(connection.base);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <div className="login-theme">
        <ThemeButton />
      </div>
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await login(base, token);
            connected();
          } catch (error) {
            setError(String((error as Error).message));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Brand subtitle={server ? "SERVER" : "STUDIO"} />
        <p className="eyebrow">YOUR SPACE TO CREATE</p>
        <h1>{server ? "连接你的创作服务" : "让想法，开始连接。"}</h1>
        <p className="muted">
          连接 Zhilume Server，
          {server ? "管理执行端、任务与素材。" : "进入属于你的创作画布。"}
        </p>
        <label>
          Server 地址
          <input
            aria-label="Server 地址"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="留空使用当前站点 / 本地开发代理"
          />
        </label>
        <label>
          访问凭证
          <input
            aria-label="访问凭证"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="启动器复制凭证 / 终端 npm run credential"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary full" disabled={busy}>
          {busy ? "正在连接…" : "连接 Server"}
        </button>
        <small className="muted">
          EXE：在启动器复制访问凭证。终端：在相同数据目录配置下运行 npm run credential。
        </small>
      </form>
    </div>
  );
}
