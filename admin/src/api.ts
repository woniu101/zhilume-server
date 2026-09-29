declare global {
  interface Window {
    zhilumeAdmin?: { session: () => Promise<{ token: string }>; openStorage?: () => Promise<void> };
  }
}
export async function restoreAdminSession() {
  if (!window.zhilumeAdmin) return;
  const result = await window.zhilumeAdmin.session();
  connection.base = "";
  connection.token = result.token;
  sessionStorage.setItem("zhilume.admin.session", result.token);
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const connection = {
  base:
    localStorage.getItem("zhilume.admin.server") ||
    (location.protocol === "app:" ? "http://127.0.0.1:4310" : ""),
  token: sessionStorage.getItem("zhilume.admin.session") || "",
};
export async function api(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<any> {
  const binary = body instanceof Blob;
  const response = await fetch(connection.base + "/api/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + connection.token,
      ...(body !== undefined
        ? {
            "Content-Type": binary
              ? "application/octet-stream"
              : "application/json",
          }
        : {}),
    },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      error.code,
      error.message || `请求失败 (${response.status})`,
    );
  }
  return response.status === 204 ? null : response.json();
}
export const mediaUrl = (url: string) => connection.base + url;
export async function login(base: string, token: string) {
  const normalized = base.trim().replace(/\/$/, "");
  if (normalized && !/^https?:\/\//.test(normalized))
    throw new Error("请输入 http:// 或 https:// 开头的 Server 地址");
  connection.base = normalized;
  const result = await api("/session", "POST", { token });
  connection.token = result.token;
  sessionStorage.setItem("zhilume.admin.session", result.token);
  localStorage.setItem("zhilume.admin.server", normalized);
}
export function logout() {
  connection.token = "";
  sessionStorage.removeItem("zhilume.admin.session");
}
export const sizeLabel = (bytes: number) =>
  bytes < 1024 ** 2
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
export const statusLabel: Record<string, string> = {
  waiting_upstream: "等待上游",
  blocked: "上游失败，已阻塞",
  queued: "排队中",
  assigned: "准备执行",
  running: "执行中",
  cancel_requested: "正在停止",
  succeeded: "已完成",
  failed: "失败",
  interrupted: "已中断",
  cancelled: "已取消",
};
