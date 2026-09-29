import { useEffect, useState } from "react";
import { api, mediaUrl, sizeLabel, connection } from "./api";
import { Modal } from "./ui";
const kinds: Record<string, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  text: "文本",
};
export function AssetStorage({ assets, stats }: { assets: any[]; stats: any }) {
  const [filter, setFilter] = useState(""),
    [kind, setKind] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [error, setError] = useState("");
  async function open(a: any) {
    try {
      const current = await api("/assets/" + a.id);
      setPreview(current);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const rows = assets.filter(
    (a) =>
      (!kind || a.kind === kind) &&
      a.filename.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <section className="admin-card">
      <div className="card-heading">
        <h2>已归档素材 · {assets.length}</h2>
        <span className="muted">Server 文件存储</span>
      </div>
      <div className="storage-location">
        <span>素材实际存储目录（位于 Server 所在机器）</span>
        <code>{stats?.assetsDirectory || "正在读取…"}</code>
        <div className="row">
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(stats?.assetsDirectory || "")
                .catch(() => setError("无法复制，请手动选择路径"))
            }
          >
            复制路径
          </button>
          {window.zhilumeAdmin?.openStorage && (
            <button
              onClick={() =>
                void window.zhilumeAdmin!.openStorage!().catch((e: Error) =>
                  setError(e.message),
                )
              }
            >
              打开素材文件夹
            </button>
          )}
        </div>
        <p className="muted">
          文件按素材 ID 归档，原始名称见下表。请在 Studio
          管理项目引用，不要直接改动归档文件。
        </p>
      </div>
      <div className="provider-list">
        <div className="row">
          <input
            aria-label="搜索素材"
            placeholder="搜索文件名"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            aria-label="筛选素材类型"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">全部类型</option>
            {Object.entries(kinds).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>文件名</th>
              <th>类型</th>
              <th>大小</th>
              <th>归档时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>{a.filename}</td>
                <td>{kinds[a.kind] || a.kind}</td>
                <td>{sizeLabel(a.size)}</td>
                <td>{new Date(a.createdAt).toLocaleString()}</td>
                <td>
                  <button onClick={() => void open(a)}>查看</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="provider-empty">没有匹配的素材</p>}
      </div>
      {preview && (
        <Modal title={preview.filename} close={() => setPreview(null)}>
          <AssetPreview asset={preview} />
          <p className="muted">素材 ID：{preview.id}</p>
          <p className="muted">
            SHA256：
            <code style={{ overflowWrap: "anywhere" }}>{preview.sha256}</code>
          </p>
        </Modal>
      )}
    </section>
  );
}
function AssetPreview({ asset }: { asset: any }) {
  const [content, setContent] = useState("");
  useEffect(() => {
    if (asset.kind !== "text") return;
    const controller = new AbortController();
    void fetch(connection.base + "/api/v1/assets/" + asset.id + "/content", {
      headers: { Authorization: "Bearer " + connection.token },
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw Error();
        return r.text();
      })
      .then(setContent)
      .catch(() => setContent("文本加载失败"));
    return () => controller.abort();
  }, [asset.id]);
  const url = mediaUrl(asset.url);
  if (asset.kind === "image")
    return <img className="asset-preview" src={url} alt={asset.filename} />;
  if (asset.kind === "video")
    return <video className="asset-preview" src={url} controls />;
  if (asset.kind === "audio")
    return <audio className="asset-preview" src={url} controls />;
  return <pre className="asset-text">{content || "正在加载…"}</pre>;
}
