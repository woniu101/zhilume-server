import { WebSocket } from 'ws';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './domain.js';

export type WorkerEndpoint = { address: string; credential: string };
export function endpoint(value: any): WorkerEndpoint {
  let url: URL;
  try { url = new URL(value?.address); } catch { throw new AppError('invalid_address', '请输入有效的 Worker HTTP/HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new AppError('invalid_address', '地址不能包含账号、查询参数或片段');
  if (typeof value.credential !== 'string' || value.credential.length < 16 || value.credential.length > 256 || /[\r\n]/.test(value.credential))
    throw new AppError('invalid_credential', '请输入 Worker 接入密钥');
  return { address: url.toString().replace(/\/+$/, ''), credential: value.credential };
}
export async function probeWorker(config: WorkerEndpoint, serverId?: string) {
  let response: Response;
  try {
    response = await fetch(config.address + '/api/v1/system', { headers: { Authorization: 'Bearer ' + config.credential }, redirect: 'error', signal: AbortSignal.timeout(8000) });
  } catch { throw new AppError('worker_unreachable', '无法访问 Worker，请检查地址、网络和服务状态', 502); }
  if ([401, 403].includes(response.status)) throw new AppError('worker_auth_failed', 'Worker 接入密钥无效或访问被拒绝', 400);
  if (!response.ok || Number(response.headers.get('content-length')) > 65536) throw new AppError('worker_invalid_service', '地址未提供有效的 Worker 服务', 400);
  let info: any;
  try { const raw = await response.text(); if (raw.length > 65536) throw Error(); info = JSON.parse(raw); } catch { throw new AppError('worker_invalid_service', '响应不是有效的 Worker 服务', 400); }
  if (info.name !== 'Zhilume Worker' || info.protocolVersion !== '3.0' || typeof info.workerId !== 'string' || !/^[0-9a-f-]{36}$/.test(info.workerId))
    throw new AppError('worker_protocol_mismatch', 'Worker 身份或协议版本不匹配，请更新 Worker', 400);
  if (serverId && info.boundServerId && info.boundServerId !== serverId)
    throw new AppError('worker_already_bound', '此 Worker 已绑定其他 Server，请使用独立 Worker 状态目录', 409);
  return info;
}

/** Only Server initiates connections. Credentials never enter public worker records. */
export class WorkerTransport {
  readonly serverId: string;
  private configs: Record<string, WorkerEndpoint>;
  private file: string;
  private connections = new Map<string, WebSocket>();
  private retries = new Map<string, { at: number; delay: number }>();
  private transfers = new Set<AbortController>();
  constructor(root: string, private changed: (id: string, error: string | null) => void) {
    this.file = join(root, 'worker-connections.json');
    const data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { serverId: randomUUID(), workers: {} };
    this.serverId = data.serverId; this.configs = data.workers;
    this.persist();
  }
  private persist() {
    const temporary = this.file + '.tmp';
    writeFileSync(temporary, JSON.stringify({ serverId: this.serverId, workers: this.configs }), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
  set(id: string, config: WorkerEndpoint) { this.configs[id] = config; this.persist(); this.disconnect(id); this.retries.delete(id); }
  get(id: string) { return this.configs[id]; }
  disconnect(id: string) { const s = this.connections.get(id); this.connections.delete(id); s?.terminate(); }
  connect(worker: any, attach: (socket: WebSocket) => void) {
    const config = this.configs[worker.id];
    if (!config || worker.disabled || this.connections.has(worker.id)) return;
    const retry = this.retries.get(worker.id);
    if (retry && retry.at > Date.now()) return;
    const url = config.address.replace(/^http/, 'ws') + '/api/v1/connect';
    const socket = new WebSocket(url, { headers: this.headers(worker.id), handshakeTimeout: 8000, maxPayload: 256 * 1024, followRedirects: false });
    this.connections.set(worker.id, socket);
    let reason = 'Worker 连接中断，正在重连';
    socket.on('error', () => { reason = '无法连接 Worker，请检查地址、密钥及服务状态'; });
    socket.on('unexpected-response', (_request, response) => {
      reason = [401, 403].includes(response.statusCode || 0) ? 'Worker 拒绝连接，请检查密钥和 Server 绑定' : 'Worker WebSocket 握手失败';
      response.destroy(); socket.terminate();
    });
    socket.on('open', () => { this.changed(worker.id, null); });
    socket.on('close', () => {
      if (this.connections.get(worker.id) !== socket) return;
      this.connections.delete(worker.id);
      const delay = Math.min(30000, (this.retries.get(worker.id)?.delay || 500) * 2);
      this.retries.set(worker.id, { at: Date.now() + delay, delay });
      this.changed(worker.id, reason);
    });
    attach(socket);
  }
  welcomed(id: string) { this.retries.delete(id); }
  headers(id: string, leaseId?: string) {
    const config = this.configs[id];
    if (!config) throw new AppError('worker_missing', '执行端连接配置不存在');
    return { Authorization: 'Bearer ' + config.credential, 'X-Zhilume-Server-Id': this.serverId, ...(leaseId ? { 'X-Lease-Id': leaseId } : {}) };
  }
  async transfer<T>(id: string, path: string, init: RequestInit & { duplex?: 'half' }, consume: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController(); this.transfers.add(controller);
    const timer = setTimeout(() => controller.abort(), 300000); timer.unref();
    try {
      const response = await fetch(this.configs[id].address + path, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new AppError('worker_transfer_failed', 'Worker 文件传输失败，请检查连接后重试', 502); }
      return await consume(response);
    } finally { clearTimeout(timer); this.transfers.delete(controller); }
  }
  close() { for (const id of this.connections.keys()) this.disconnect(id); for (const c of this.transfers) c.abort(); }
}
