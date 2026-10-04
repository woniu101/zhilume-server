import { resultTarget, archiveNodeResult } from './node-results.js';
import { workerLanguageModels, validateWorkerLanguage, validateLanguageProfiles } from './worker-language.js';
import { validateLanguageOutput } from './language-request.js';
import { LanguageService, languageOperations } from './language.js';
import { fingerprint as taskFingerprint, validateDeployment, route, validateGraph, bindInput } from './execution.js';
import { videoCapabilities, isVideoOperation, videoAvailability, validateVideoInput, validateVideoProfiles, supportsVideoJob } from './video-operations.js';
import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import { Ajv } from "ajv";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { WorkerTransport, endpoint, probeWorker } from "./worker-transport.js";
import { workerStatus } from "./worker-status.js";
import { ServerMediaQueue } from './media-queue.js';
import { Store } from "./store.js";
import { Assets } from "./assets.js";
import { queryAssets, assetIds } from './asset-query.js';
import {
  AppError,
  id,
  now,
  terminal,
  operations,
  capabilities,
  text,
  requireValue,
  validateCanvas,
} from "./domain.js";
import { mediaCapabilities, validateMediaInput, validateProvenance } from "./media-operations.js";
import { imageCapabilities, isImageOperation, modelAvailability, validateImageInput, validateImageProfiles, supportsImageJob } from "./image-operations.js";
import { speechCapabilities, isSpeechOperation, speechAvailability, validateSpeechInput, validateSpeechProfiles, supportsSpeechJob } from './speech-operations.js';
const executableCapabilities = [...capabilities, ...mediaCapabilities, ...imageCapabilities, ...speechCapabilities, ...videoCapabilities];
const executableOperations = [...executableCapabilities.map(c => c.id), ...languageOperations];
import type { WebSocket } from "ws";

export interface Options {
  root: string;
  token?: string;
  logger?: boolean;
  tickMs?: number;
  leaseMs?: number;
  mediaExecutable?: string;
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export async function createApp(options: Options) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 2 * 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const store = new Store(options.root);
  const tokenPath = join(options.root, "admin-token");
  const adminToken =
    options.token ||
    (existsSync(tokenPath)
      ? readFileSync(tokenPath, "utf8").trim()
      : randomBytes(24).toString("base64url"));
  if (!options.token && !existsSync(tokenPath))
    writeFileSync(tokenPath, adminToken, { mode: 0o600 });
  const assets = new Assets(
    store,
    adminToken,
    Number(process.env.ZHILUME_UPLOAD_LIMIT || 1024 ** 3),
  );
  const schema = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../contracts/worker-message.schema.json", import.meta.url),
      ),
      "utf8",
    ),
  );
  const validMessage = new Ajv({ strict: false }).compile<any>(schema);
  const peers = new Map<string, WebSocket>();
  const events = new Set<WebSocket>();
  const tickets = new Map<string, number>();
  const leaseMs = options.leaseMs || 90000;
  let closed = false;
  for (const worker of store.all("worker"))
    store.put("worker", { ...worker, connected: false });
  const emit = (type: string, payload: any = {}) => {
    const data = JSON.stringify({ type, payload });
    for (const s of events) if (s.readyState === 1) s.send(data);
  };
  const send = (
    workerId: string,
    type: string,
    payload: any = {},
    job?: any,
  ) => {
    const socket = peers.get(workerId);
    if (socket?.readyState !== 1) return;
    socket.send(
      JSON.stringify({
        protocolVersion: "3.0",
        messageId: id(),
        type,
        payload,
        ...(job
          ? { jobId: job.id, attemptId: job.attemptId, leaseId: job.leaseId }
          : {}),
      }),
    );
  };
  // All execution backends persist the job and its node result together.
  const recordJob = (job: any) => {
    job.updatedAt = now();
    store.put("job", job);
    archiveNodeResult(store, job);
  };
  const saveJob = (job: any) => {
    recordJob(job);
    emit("job.changed", { id: job.id });
    return job;
  };
  const mediaQueue = new ServerMediaQueue(store, assets, saveJob, options.mediaExecutable);
  const language = new LanguageService(store, assets, saveJob);
  const pendingTransfers = new Set<Promise<any>>();
  const uploads = new Set<string>(), downloads = new Set<string>();
  const transport = new WorkerTransport(options.root, (workerId, lastError) => {
    if (closed) return;
    const w = store.get("worker", workerId);
    if (w) { store.put("worker", { ...w, lastError }); emit("worker.changed"); }
  });
  const publicAsset = (a: any) => assets.decorate(a);
  const publicJob = (job: any) => ({
    ...job,
    output: job.outputAssetId
      ? publicAsset(requireValue(store.get("asset", job.outputAssetId)))
      : null,
  });
  const auth = (request: any) => {
    const token = String(request.headers.authorization || "").replace(
      /^Bearer /,
      "",
    );
    if (equal(token, adminToken)) return { role: "admin", id: "owner" };
    const session = store.get("session", digest(token));
    if (session && session.expires > Date.now())
      return { role: "admin", id: "owner" };
    throw new AppError("unauthorized", "请连接 Server 并验证访问凭证", 401);
  };
  const owner = (req: any) => {
    if (auth(req).role !== "admin")
      throw new AppError("forbidden", "此操作仅供管理员使用", 403);
  };
  const getProject = (projectId: string, editable = false) => {
    const p = requireValue(store.get("project", projectId), "项目不存在");
    if (editable && p.archivedAt)
      throw new AppError("project_archived", "项目已归档，请先恢复", 409);
    return p;
  };
  await app.register(cors, {
    // Desktop app:// and separately hosted Studio must preflight mutations.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin(origin, cb) {
      const allowed = (
        process.env.ZHILUME_ORIGINS ||
        "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174,app://zhilume-studio,app://zhilume-server"
      ).split(",");
      cb(null, !origin || allowed.includes(origin));
    },
    exposedHeaders: ["Content-Range", "X-Content-SHA256"],
  });
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  app.addContentTypeParser("application/octet-stream", (req, payload, done) =>
    done(null, payload),
  );
  app.setErrorHandler((error: any, req, reply) => {
    if (error.statusCode >= 500) app.log.error(error);
    reply.code(error.statusCode || 500).send({
      requestId: req.id,
      code: error.code || "internal_error",
      message:
        error.statusCode && error.statusCode < 500
          ? error.message
          : "服务暂时无法完成请求",
    });
  });
  const identity = store.get("system", "identity") || store.put("system", { id: "identity", serverId: randomUUID() });
  app.get("/api/v1/system", async () => ({
    serverId: identity.serverId,
    name: "Zhilume Server",
    version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
    protocolVersion: "3.2",
    authentication: true,
  }));
  const loginAttempts = new Map<string, { count: number; until: number }>();
  app.post("/api/v1/session", async (req: any, reply) => {
    const previous = loginAttempts.get(req.ip);
    if (previous && previous.until > Date.now() && previous.count >= 10)
      throw new AppError("rate_limited", "尝试过于频繁，请稍后重试", 429);
    if (!equal(String(req.body?.token || ""), adminToken)) {
      loginAttempts.set(req.ip, {
        count: previous && previous.until > Date.now() ? previous.count + 1 : 1,
        until: Date.now() + 60000,
      });
      throw new AppError("invalid_credential", "访问凭证不正确", 401);
    }
    loginAttempts.delete(req.ip);
    return issueSession();
  });
  function issueSession() {
    const token = randomBytes(32).toString("base64url"), refreshToken = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 86400000;
    store.put("session", { id: digest(token), expires: expiresAt });
    store.put("device-session", { id: digest(refreshToken), accessId: digest(token), expires: Date.now() + 30 * 86400000 });
    return { token, refreshToken, expiresAt, expiresIn: 86400, serverId: identity.serverId };
  }
  app.get("/api/v1/session/status", async (req) => { owner(req); return { serverId: identity.serverId }; });
  app.post("/api/v1/session/renew", async (req: any) => store.atomic(() => {
    const id = digest(String(req.body?.refreshToken || "")), session = store.get("device-session", id);
    if (!session || session.expires <= Date.now()) throw new AppError("unauthorized", "设备授权已失效，请重新验证", 401);
    store.remove("device-session", id);
    store.remove("session", session.accessId);
    return issueSession();
  }));
  app.post("/api/v1/session/revoke", async (req: any) => {
    const id = digest(String(req.body?.refreshToken || "")), session = store.get("device-session", id);
    if (session) { store.remove("device-session", id); store.remove("session", session.accessId); }
    return { revoked: true };
  });
  app.get("/api/v1/projects", async (req) => {
    owner(req);
    return store.all("project");
  });
  app.post("/api/v1/projects", async (req: any, reply) => {
    owner(req);
    const p = {
      id: id(),
      name: text(req.body?.name, 100),
      createdAt: now(),
      updatedAt: now(),
      archivedAt: null,
    };
    store.atomic(() => {
      store.put("project", p);
      store.put("canvas", {
        id: p.id,
        schemaVersion: 1,
        revision: 0,
        nodes: [],
        edges: [],
      });
    });
    return reply.code(201).send(p);
  });
  app.patch("/api/v1/projects/:id", async (req: any) => {
    owner(req);
    const p = getProject(req.params.id);
    if (req.body.name !== undefined) p.name = text(req.body.name, 100);
    if (req.body.archived !== undefined) {
      if (typeof req.body.archived !== "boolean")
        throw new AppError("invalid_input", "归档标记必须为布尔值");
      if (
        req.body.archived &&
        store
          .all("job")
          .some((j) => j.projectId === p.id && !terminal.has(j.status))
      )
        throw new AppError("active_jobs", "请先等待或取消项目中的任务", 409);
      p.archivedAt = req.body.archived ? now() : null;
    }
    p.updatedAt = now();
    return store.put("project", p);
  });
  app.get('/api/v1/projects/:id/node-results', async (req: any) => {
    owner(req); getProject(req.params.id);
    return store.all('node-result').filter(r => r.projectId === req.params.id).reverse().map(r => {
      const a = requireValue(store.get('asset', r.outputAssetId));
      return { ...r, output: { ...publicAsset(a), ...(a.kind === 'text' ? { text: readFileSync(assets.path(a), 'utf8') } : {}) } };
    });
  });
  app.get("/api/v1/projects/:id/canvas", async (req: any) => {
    owner(req);
    getProject(req.params.id);
    return store.get("canvas", req.params.id);
  });
  app.put("/api/v1/projects/:id/canvas", async (req: any) => {
    owner(req);
    const project = getProject(req.params.id, true);
    const body = req.body;
    validateCanvas(body);
    for (const node of body.nodes)
      if (node.data?.assetId)
        requireValue(
          store.get("asset", node.data.assetId),
          "画布引用的素材不存在",
        );
    return store.atomic(() => {
      const old = store.get("canvas", project.id)!;
      if (body.baseRevision !== old.revision)
        throw new AppError(
          "revision_conflict",
          "画布已在其他窗口修改，本地草稿已保留",
          409,
        );
      for (const node of body.nodes) {
        const previous = old.nodes.find((n:any) => n.id === node.id);
        if (!previous || previous.data.kind === node.data.kind) continue;
        const d = previous.data;
        if (d.assetId || d.text?.trim() || d.html || d.versions?.length ||
            old.edges.some((e:any) => e.source === node.id || e.target === node.id) ||
            store.all('job').some(j => j.projectId === project.id && j.nodeId === node.id && (j.status === 'succeeded' || !terminal.has(j.status))))
          throw new AppError('node_kind_locked', '已有内容、连接或正在执行的节点不能改变内容类型', 409);
      }
      const doc = {
        id: project.id,
        schemaVersion: 1,
        revision: old.revision + 1,
        nodes: body.nodes,
        edges: body.edges,
        ...(body.viewport ? { viewport: body.viewport } : {}),
      };
      store.put("canvas", doc);
      store.put("project", { ...project, updatedAt: now() });
      emit("canvas.changed", { id: project.id, revision: doc.revision });
      return doc;
    });
  });
  app.post(
    "/api/v1/assets/uploads",
    { bodyLimit: 1024 ** 3 },
    async (req: any, reply) => {
      owner(req);
      if (!req.body?.pipe)
        throw new AppError("invalid_body", "使用二进制文件上传");
      const syncId = req.headers['x-media-sync-id'];
      if (syncId !== undefined && (typeof syncId !== 'string' || !/^[a-f0-9-]{36}$/.test(syncId)))
        throw new AppError('invalid_sync_id', '媒体同步标识无效');
      const existing = syncId && store.all('asset').find(a => a.syncId === syncId && !a.staged);
      if (existing) { req.body.resume(); return reply.code(200).send(publicAsset(existing)); }
      if (syncId && uploads.has(syncId)) throw new AppError('sync_busy', '此结果正在同步，请稍后重试', 409);
      if (syncId) uploads.add(syncId);
      try {
      const asset = await assets.ingest(
        req.body,
        text(req.query.filename, 255),
        { ...(syncId ? { syncId } : {}), provenance: validateProvenance(req.headers["x-asset-provenance"], id => store.get("asset", id)) },
      );
      return reply.code(201).send(publicAsset(asset));
      } finally { if (syncId) uploads.delete(syncId); }
    },
  );
  app.get("/api/v1/assets", async (req) => {
    owner(req);
    return store
      .all("asset")
      .filter((a) => !a.staged)
      .map(publicAsset);
  });
  app.post('/api/v1/assets/query', async (req: any) => {
    owner(req);
    const page = queryAssets(store, req.body);
    return { ...page, items: page.items.map(publicAsset) };
  });
  app.post('/api/v1/assets/resolve', async (req: any) => {
    owner(req);
    return assetIds(req.body?.ids).map(id => store.get('asset', id)).filter(a => a && !a.staged).map(publicAsset);
  });
  app.get("/api/v1/assets/:id", async (req: any) => {
    owner(req);
    return publicAsset(requireValue(store.get("asset", req.params.id)));
  });
  app.get("/api/v1/assets/:id/content", async (req: any, reply) => {
    if (!assets.valid(req.params.id, req.query)) owner(req);
    return assets.serve(
      requireValue(store.get("asset", req.params.id)),
      req,
      reply,
    );
  });
  app.get("/api/v1/projects/:id/library", async (req: any) => {
    owner(req);
    getProject(req.params.id);
    return {
      items: store
        .all("library")
        .filter((i) => i.projectId === req.params.id)
        .map((i) => ({
          ...i,
          asset: publicAsset(requireValue(store.get("asset", i.assetId))),
        })),
      folders: store.all("folder").filter((f) => f.projectId === req.params.id),
    };
  });
  app.post("/api/v1/projects/:id/library", async (req: any) => {
    owner(req);
    getProject(req.params.id, true);
    let asset = req.body.assetId
      ? requireValue(store.get("asset", req.body.assetId))
      : null;
    if (!asset && req.body.text !== undefined)
      asset = await assets.ingest(
        Readable.from([Buffer.from(text(req.body.text))]),
        "文本.txt",
      );
    if (!asset || asset.staged)
      throw new AppError("invalid_asset", "请选择已归档的内容");
    const folderId = req.body.folderId || null;
    if (folderId && store.get("folder", folderId)?.projectId !== req.params.id)
      throw new AppError("invalid_folder", "文件夹不属于当前项目");
    const base = text(req.body.name || asset.filename, 200);
    let name = base,
      n = 2;
    const used = store
      .all("library")
      .filter((i) => i.projectId === req.params.id && i.folderId === folderId)
      .map((i) => i.name);
    while (used.includes(name)) name = `${base} (${n++})`;
    return store.put("library", {
      id: id(),
      projectId: req.params.id,
      assetId: asset.id,
      folderId,
      name,
      description: "",
      createdAt: now(),
    });
  });
  app.patch("/api/v1/library/:id", async (req: any) => {
    owner(req);
    const item = requireValue(store.get("library", req.params.id));
    getProject(item.projectId, true);
    if (req.body.name !== undefined) item.name = text(req.body.name, 200);
    if (req.body.description !== undefined)
      item.description = String(req.body.description).slice(0, 2000);
    if (req.body.folderId !== undefined) {
      if (
        req.body.folderId &&
        store.get("folder", req.body.folderId)?.projectId !== item.projectId
      )
        throw new AppError("invalid_folder", "文件夹不属于当前项目");
      item.folderId = req.body.folderId || null;
    }
    return store.put("library", item);
  });
  app.delete("/api/v1/library/:id", async (req: any, reply) => {
    owner(req);
    const item = requireValue(store.get("library", req.params.id));
    getProject(item.projectId, true);
    store.remove("library", item.id);
    return reply.code(204).send();
  });
  app.post("/api/v1/projects/:id/folders", async (req: any) => {
    owner(req);
    getProject(req.params.id, true);
    const parentId = req.body.parentId || null;
    if (parentId && store.get("folder", parentId)?.projectId !== req.params.id)
      throw new AppError("invalid_folder", "上级文件夹不属于当前项目");
    return store.put("folder", {
      id: id(),
      projectId: req.params.id,
      name: text(req.body.name, 100),
      parentId,
    });
  });
  app.patch("/api/v1/folders/:id", async (req: any) => {
    owner(req);
    const folder = requireValue(store.get("folder", req.params.id));
    getProject(folder.projectId, true);
    if (req.body.name !== undefined) folder.name = text(req.body.name, 100);
    if (req.body.parentId !== undefined) {
      let parentId = req.body.parentId || null;
      const visited = new Set([folder.id]);
      while (parentId) {
        if (visited.has(parentId))
          throw new AppError("folder_cycle", "不能移动到自身或下级文件夹");
        visited.add(parentId);
        const parent = requireValue(store.get("folder", parentId));
        if (parent.projectId !== folder.projectId)
          throw new AppError("invalid_folder", "目标文件夹不属于当前项目");
        parentId = parent.parentId;
      }
      folder.parentId = req.body.parentId || null;
    }
    return store.put("folder", folder);
  });
  app.delete("/api/v1/folders/:id", async (req: any, reply) => {
    owner(req);
    const folder = requireValue(store.get("folder", req.params.id));
    getProject(folder.projectId, true);
    // Removing a folder only dissolves its organization; media and children survive.
    store.atomic(() => {
      for (const item of store
        .all("library")
        .filter((i) => i.folderId === folder.id))
        store.put("library", { ...item, folderId: folder.parentId });
      for (const child of store
        .all("folder")
        .filter((f) => f.parentId === folder.id))
        store.put("folder", { ...child, parentId: folder.parentId });
      store.remove("folder", folder.id);
    });
    return reply.code(204).send();
  });
  app.get("/api/v1/capabilities", async (req) => {
    owner(req);
    return [...languageOperations.map(id => ({id, name: id === "text.generate.v1" ? "文本生成" : "提示词优化", executor: "api", ready: [...language.models(), ...workerLanguageModels(knownWorkers())].some(m => m.ready)})), ...executableCapabilities.map((c) => ({
      ...c,
      executor: c.id.startsWith('media.') ? 'server' : 'worker',
      ready: c.id.startsWith('media.') ? mediaQueue.ready : store
        .all("worker")
        .some(
          (w) =>
            w.connected &&
            !w.disabled &&
            Date.now() - w.lastHeartbeat < 40000 &&
            w.capabilities.includes(c.id),
        ),
    }))];
  });
  app.get("/api/v1/video-models", async (req) => { owner(req); return videoAvailability(knownWorkers()); });
  app.get("/api/v1/speech-models", async (req) => { owner(req); return speechAvailability(knownWorkers()); });
  app.get("/api/v1/image-models", async (req) => { owner(req); return modelAvailability(knownWorkers()); });
  app.get("/api/v1/jobs", async (req: any) => {
    owner(req);
    return store
      .all("job")
      .filter(
        (j) => !req.query.projectId || j.projectId === req.query.projectId,
      )
      .slice(0, 200)
      .map(publicJob);
  });
  app.get("/api/v1/jobs/:id", async (req: any) => {
    owner(req);
    return publicJob(requireValue(store.get("job", req.params.id)));
  });
  function knownWorkers() {
    return [...store.all("worker"), { id: 'registry', name: '已登记规格', connected: false, imageProfiles: store.all('execution-spec').filter(s => s.kind === 'image').map(s => s.spec), speechProfiles: store.all('execution-spec').filter(s => s.kind === 'speech').map(s => s.spec), languageProfiles: store.all('execution-spec').filter(s => s.kind === 'language').map(s => s.spec), videoProfiles: store.all('execution-spec').filter(s => s.kind === 'video').map(s => s.spec) }];
  }
  function normalize(operation: string, input: any, lookup = (assetId: string) => store.get('asset', assetId)): any {
    if (!executableOperations.includes(operation)) throw new AppError('unknown_capability', '不支持此执行能力');
    return languageOperations.includes(operation) ? (store.get('language-spec', input?.profileId) ? language.validate(operation, input, lookup) : validateWorkerLanguage(operation, input, knownWorkers(), lookup))
      : isVideoOperation(operation) ? validateVideoInput(input, knownWorkers(), lookup)
      : isSpeechOperation(operation) ? validateSpeechInput(input, knownWorkers(), lookup)
      : isImageOperation(operation) ? validateImageInput(operation, input, knownWorkers(), lookup)
      : operation.startsWith('media.') ? validateMediaInput(operation, input, requireValue(lookup(input?.assetId), '输入素材不存在'))
      : operation === operations[0] ? { text: text(input?.text) }
      : { assetId: requireValue(lookup(input?.assetId), '输入素材不存在').id };
  }
  function prepareJob(b: any, input: any, extra: any = {}) {
    const project = getProject(b.projectId, true);
    if (b.nodeId && !store.get('canvas', project.id)?.nodes.some((n: any) => n.id === b.nodeId)) throw new AppError('node_missing', '请先保存画布节点');
    if (b.nodeId && b.operation !== 'prompt.optimize.v1' && store.all('job').some(j => j.nodeId === b.nodeId && j.projectId === project.id && j.operation !== 'prompt.optimize.v1' && !terminal.has(j.status))) throw new AppError('node_busy', '此节点已有未结束任务', 409);
    const targetWorkerId = b.targetWorkerId ? text(b.targetWorkerId, 100) : null;
    const executor = languageOperations.includes(b.operation) && store.get('language-spec', input.profileId) ? 'api' : b.operation.startsWith('media.') ? 'server' : 'worker';
    if (targetWorkerId && (!store.get('worker', targetWorkerId) || executor !== 'worker')) throw new AppError('invalid_target', '此任务不能指定该执行端');
    if (executor === 'server' && !mediaQueue.ready) throw new AppError('ffmpeg_unavailable', 'Server 内置 FFmpeg 不可用', 503);
    const assetIds = [...new Set([...(input.referenceAssetIds || []), ...(input.assetId ? [input.assetId] : [])])];
    return { id: id(), requestId: text(b.requestId, 100), fingerprint: taskFingerprint(b), projectId: project.id, nodeId: b.nodeId || null,
      resultTarget: resultTarget(store.get('canvas', project.id)?.nodes.find((n: any) => n.id === b.nodeId), b.operation),
      operation: b.operation, executor, targetWorkerId, input: structuredClone(input), frozenAssets: assetIds.map(a => store.get('asset', a)).filter(Boolean).map(a => ({ id: a.id, sha256: a.sha256, size: a.size })),
      status: 'queued', stage: '等待分配', waitReason: 'resource_busy', progress: null, simulation: b.operation.startsWith('mock.'), attemptId: id(), leaseId: null, workerId: null, sequence: 0, attempts: [], createdAt: now(), updatedAt: now(), sourceRevision: store.get('canvas', project.id)?.revision,
      outputAssetId: null, error: null, errorCode: null, ...extra };
  }
  app.get('/api/v1/language/providers', async req => { owner(req); return language.providers(); });
  app.post('/api/v1/language/providers', async (req: any) => { owner(req); return language.configure(req.body); });
  app.post('/api/v1/language/providers/discover', async (req: any) => { owner(req); return language.discover(req.body); });
  app.get('/api/v1/language/models', async req => { owner(req); return [...language.models(), ...workerLanguageModels(knownWorkers())]; });
  app.get('/api/v1/models', async req => { owner(req); return { image: modelAvailability(knownWorkers()), speech: speechAvailability(knownWorkers()), video: videoAvailability(knownWorkers()), language: [...language.models(), ...workerLanguageModels(knownWorkers())] }; });
  app.post('/api/v1/jobs', async (req: any, reply) => {
    owner(req); const b = req.body; text(b.requestId, 100);
    const previous = store.all('job').find(j => j.requestId === b.requestId);
    if (previous) { if (previous.fingerprint !== taskFingerprint(b)) throw new AppError('idempotency_conflict', '相同请求标识不能用于不同任务', 409); return publicJob(previous); }
    const job = prepareJob(b, normalize(b.operation, b.input)); saveJob(job); schedule(); return reply.code(201).send(publicJob(store.get('job', job.id)));
  });
  app.post('/api/v1/job-groups', async (req: any, reply) => {
    owner(req); const b = req.body, requestId = text(b.requestId, 100), fingerprint = taskFingerprint(b);
    const prior = store.all('job-group').find(g => g.requestId === requestId);
    if (prior) { if (prior.fingerprint !== fingerprint) throw new AppError('idempotency_conflict', '批次请求内容已变更', 409); return { ...prior, jobs: prior.jobIds.map((j: string) => publicJob(store.get('job', j))) }; }
    getProject(b.projectId, true); validateGraph(b.tasks, b.mode);
    const groupId = id(), taskMap = new Map<string, any>(b.tasks.map((t: any) => [t.key, t]));
    const virtual = new Map<string, any>();
    function outputKind(task: any): string {
      if (task.operation === 'mock.media.copy.v1') { const binding = task.bindings?.find((b: any) => b.target === 'assetId'); return binding ? outputKind(taskMap.get(binding.from)) : requireValue(store.get('asset', task.input?.assetId), '输入素材不存在').kind; }
      return task.operation.startsWith('image.') ? 'image' : task.operation.startsWith('audio.') || task.operation === 'media.audio.extract.v1' ? 'audio' : task.operation.startsWith('video.') || task.operation === 'media.video.trim.v1' ? 'video' : 'text';
    }
    const jobs = b.tasks.map((t: any) => {
      const validationInput = structuredClone(t.input);
      for (const bind of t.bindings || []) {
        const kind = outputKind(taskMap.get(bind.from));
        if (['text', 'prompt'].includes(bind.target)) { if (kind !== 'text') throw new AppError('binding_kind', '文字输入需要上游文本'); bindInput(validationInput, bind.target, '待上游文本'); }
        else { const aid = 'upstream-' + bind.from; virtual.set(aid, { id: aid, kind, staged: false, size: 1 }); bindInput(validationInput, bind.target, aid); }
      }
      const normalized = normalize(t.operation, validationInput, aid => virtual.get(aid) || store.get('asset', aid));
      // Freeze the normalized specification and all unbound fields; only declared slots may change.
      const frozenTemplate = structuredClone(normalized);
      for (const bind of t.bindings || []) bindInput(frozenTemplate, bind.target, '');
      return prepareJob({ ...t, projectId: b.projectId, requestId: groupId + ':' + t.key }, normalized, {
        groupId, key: t.key, inputTemplate: frozenTemplate, bindings: t.bindings || [], status: t.bindings?.length ? 'waiting_upstream' : 'queued', stage: t.bindings?.length ? '等待上游归档' : '等待分配', waitReason: t.bindings?.length ? 'upstream_pending' : 'resource_busy',
      });
    });
    const nodeIds = jobs.filter((j: any) => j.nodeId).map((j: any) => j.nodeId);
    if (new Set(nodeIds).size !== nodeIds.length) throw new AppError('node_busy', '同批次不能重复提交同一节点');
    const ids = new Map(jobs.map((j: any) => [j.key, j.id]));
    for (const j of jobs) j.bindings = j.bindings.map((x: any) => ({ ...x, jobId: ids.get(x.from) }));
    const group = { id: groupId, requestId, fingerprint, projectId: b.projectId, mode: b.mode, jobIds: jobs.map((j: any) => j.id), createdAt: now() };
    store.atomic(() => { for (const j of jobs) store.put('job', j); store.put('job-group', group); });
    emit('job.changed'); schedule(); return reply.code(201).send({ ...group, jobs: jobs.map((j: any) => publicJob(store.get('job', j.id))) });
  });
  function resolveDependencies() {
    for (const j of store.all('job').reverse().filter(j => j.status === 'waiting_upstream')) {
      const upstream = j.bindings.map((b: any) => store.get('job', b.jobId));
      if (upstream.some((u: any) => !u || (terminal.has(u.status) && u.status !== 'succeeded'))) {
        saveJob(Object.assign(j, { status: 'blocked', waitReason: 'upstream_failed', stage: '上游失败或取消', error: '重试上游成功后可重试本任务', errorCode: 'upstream_failed' })); continue;
      }
      if (!upstream.every((u: any) => u.status === 'succeeded' && u.outputAssetId && store.get('asset', u.outputAssetId)?.staged === false)) continue;
      try {
        const input = structuredClone(j.inputTemplate);
        for (const binding of j.bindings) { const u = store.get('job', binding.jobId), a = store.get('asset', u.outputAssetId); bindInput(input, binding.target, ['text', 'prompt'].includes(binding.target) ? readFileSync(assets.path(a), 'utf8') : a.id); }
        j.input = normalize(j.operation, input);
        j.frozenAssets = [...new Set([...(j.input.referenceAssetIds || []), ...(j.input.assetId ? [j.input.assetId] : [])])].map((aid: any) => { const a = store.get('asset', aid); return { id: a.id, size: a.size, sha256: a.sha256 }; });
        saveJob(Object.assign(j, { status: 'queued', waitReason: 'resource_busy', stage: '等待分配' }));
      } catch (e) { saveJob(Object.assign(j, { status: 'failed', stage: '上游结果不符合输入限制', error: (e as Error).message, errorCode: 'dependency_input_invalid' })); }
    }
  }
  app.post("/api/v1/jobs/:id/cancel", async (req: any) => {
    owner(req);
    const job = requireValue(store.get("job", req.params.id));
    if (terminal.has(job.status))
      throw new AppError("job_terminal", "任务已经结束", 409);
    if (["queued", "waiting_upstream"].includes(job.status)) {
      job.status = "cancelled";
      job.stage = "已取消";
    } else {
      job.status = "cancel_requested";
      job.stage = "等待停止确认";
      send(job.workerId, "task.cancel", {}, job);
      if (job.executor === 'server') mediaQueue.cancel(job.id);
      if (job.executor === 'api') language.cancel(job.id);
    }
    return publicJob(saveJob(job));
  });
  app.post("/api/v1/jobs/:id/retry", async (req: any) => {
    owner(req);
    const j = requireValue(store.get("job", req.params.id));
    getProject(j.projectId, true);
    if (!["failed", "interrupted", "blocked", "cancelled"].includes(j.status))
      throw new AppError("retry_not_allowed", "仅失败或中断任务可以重试", 409);
    if (j.nodeId) {
      const node = store.get('canvas', j.projectId)?.nodes.find((n:any) => n.id === j.nodeId);
      if (!node) throw new AppError('node_missing', '目标节点已删除，请在新节点提交任务', 409);
      resultTarget(node, j.operation);
      if (store.all('job').some(other => other.id !== j.id && other.projectId === j.projectId && other.nodeId === j.nodeId && other.operation !== 'prompt.optimize.v1' && !terminal.has(other.status)))
        throw new AppError('node_busy', '目标节点已有执行中的任务', 409);
    }
    if (!j.bindings?.length) normalize(j.operation, j.input);
    j.attempts.push({
      attemptId: j.attemptId,
      status: j.status,
      error: j.error,
      workerId: j.workerId,
      updatedAt: j.updatedAt,
    });
    Object.assign(j, {
      status: j.bindings?.length ? "waiting_upstream" : "queued",
      stage: j.executor === 'server' ? '等待 Server 媒体队列' : '等待执行端',
      attemptId: id(),
      leaseId: null,
      leaseExpires: 0,
      workerId: null,
      progress: null,
      sequence: 0,
      error: null,
      errorCode: null,
      outputAssetId: null,
    });
    saveJob(j);
    schedule();
    return publicJob(j);
  });
  app.get("/api/v1/workers", async (req) => {
    owner(req);
    return store.all("worker").map(({ tokenHash, ...w }) => ({ ...w, ...workerStatus(w, store.all("job")) }));
  });
  app.post("/api/v1/workers/probe", async (req: any) => {
    owner(req); return probeWorker(endpoint({ ...(req.body.id ? transport.get(req.body.id) : {}), ...req.body }), transport.serverId);
  });
  app.post("/api/v1/workers", async (req: any, reply) => {
    owner(req);
    const config = endpoint(req.body), info = await probeWorker(config, transport.serverId);
    if (store.all("worker").some(w => w.id === info.workerId || w.address === config.address))
      throw new AppError("worker_exists", "此 Worker 已接入，请编辑已有连接", 409);
    transport.set(info.workerId, config);
    const w = { id: info.workerId, name: text(req.body.name || info.workerName, 100), platform: text(info.platform, 100), address: config.address,
      capabilities: [], imageProfiles: [], connected: false, disabled: false, draining: false, lastHeartbeat: 0, lastError: null };
    store.put("worker", w); connectWorker(w);
    return reply.code(201).send(w);
  });
  app.patch("/api/v1/workers/:id", async (req: any) => {
    owner(req);
    const w = requireValue(store.get("worker", req.params.id));
    if (req.body.address !== undefined || req.body.credential !== undefined) {
      const config = endpoint({ ...transport.get(w.id), ...req.body });
      const info = await probeWorker(config, transport.serverId);
      if (info.workerId !== w.id) throw new AppError("worker_identity_changed", "地址对应的 Worker 身份已变化，请作为新执行端添加", 409);
      transport.set(w.id, config); w.address = config.address; w.connected = false;
    }
    if (req.body.name !== undefined) w.name = text(req.body.name, 100);
    if (req.body.draining !== undefined)
      w.draining = Boolean(req.body.draining);
    if (req.body.disabled !== undefined)
      w.disabled = Boolean(req.body.disabled);
    store.put("worker", w);
    if (w.disabled) transport.disconnect(w.id);
    else send(w.id, "drain", { draining: w.draining });
    emit("worker.changed");
    return { id: w.id };
  });
  app.get("/api/v1/stats", async (req) => {
    owner(req);
    const list = store.all("asset").filter((a) => !a.staged);
    const jobs = store.all("job");
    return {
      assets: list.length,
      bytes: list.reduce((sum, a) => sum + a.size, 0),
      projects: store.all("project").filter((p) => !p.archivedAt).length,
      queued: jobs.filter((j) => j.status === "queued").length,
      running: jobs.filter((j) =>
        ["running", "assigned", "cancel_requested"].includes(j.status),
      ).length,
      dataDirectory: options.root,
      assetsDirectory: join(options.root, 'assets'),
      tokenFile: options.token ? null : tokenPath,
    };
  });
  app.post("/api/v1/events/ticket", async (req) => {
    owner(req);
    const ticket = randomBytes(24).toString("base64url");
    tickets.set(ticket, Date.now() + 15000);
    return { ticket };
  });
  app.get("/api/v1/events", { websocket: true }, (socket, req: any) => {
    const t = req.query.ticket;
    const expires = tickets.get(t);
    tickets.delete(t);
    if (!expires || expires < Date.now()) {
      socket.close(1008, "Unauthorized");
      return;
    }
    events.add(socket);
    socket.on("close", () => events.delete(socket));
  });

  function assertLive(job: any) {
    const current = store.get("job", job.id);
    if (closed || !current || current.attemptId !== job.attemptId || current.leaseId !== job.leaseId || terminal.has(current.status) || current.status === "cancel_requested" || current.leaseExpires < Date.now())
      throw new AppError("stale_attempt", "当前任务尝试已失效", 409);
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    pendingTransfers.add(promise); promise.finally(() => pendingTransfers.delete(promise)).catch(() => {}); return promise;
  }
  async function pushInputs(job: any) {
    if (uploads.has(job.attemptId)) return;
    uploads.add(job.attemptId);
    try {
      await track((async () => {
        const ids = job.input.referenceAssetIds || (job.input.assetId ? [job.input.assetId] : []);
        for (const assetId of ids) {
          assertLive(job);
          const a = requireValue(store.get("asset", assetId));
          await transport.transfer(job.workerId, `/api/v1/attempts/${job.attemptId}/inputs/${assetId}`, {
            method: "PUT", headers: { ...transport.headers(job.workerId, job.leaseId), "Content-Type": "application/octet-stream", "Content-Length": String(a.size) },
            body: createReadStream(assets.path(a)) as any, duplex: "half",
          }, async response => { const result = await response.json() as any; if (result.sha256 !== a.sha256) throw new AppError("invalid_input", "输入校验不匹配"); });
        }
        assertLive(job); send(job.workerId, "task.inputs_ready", {}, job);
      })());
    } catch {
      if (!closed) { const current = store.get("job", job.id); if (current?.attemptId === job.attemptId && !terminal.has(current.status)) {
        current.stage = "输入传输中断，等待重连"; saveJob(current); transport.disconnect(job.workerId);
      } }
    } finally { uploads.delete(job.attemptId); }
  }
  async function pullOutput(job: any, result: any) {
    if (!Number.isSafeInteger(result.size) || result.size <= 0 || result.size > assets.limit || typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.sha256)) throw new AppError("invalid_output", "输出大小或校验声明无效");
    const filename = text(result.filename, 255);
    return track(transport.transfer(job.workerId, `/api/v1/attempts/${job.attemptId}/output`, { headers: transport.headers(job.workerId, job.leaseId) }, async response => {
      assertLive(job);
      if (!response.body) throw new AppError("invalid_output", "输出为空");
      const a = await assets.ingest(Readable.fromWeb(response.body as any), filename, {
        staged: true, workerId: job.workerId, attemptId: job.attemptId, jobId: job.id,
        provenance: (isImageOperation(job.operation) || isSpeechOperation(job.operation) || isVideoOperation(job.operation)) ? { operation: job.operation, sourceAssetIds: job.input.referenceAssetIds, parameters: Object.fromEntries(Object.entries(job.input).filter(([key]) => key !== "referenceAssetIds")) } : job.input.assetId ? { operation: job.operation, sourceAssetIds: [job.input.assetId], parameters: { start: job.input.start, end: job.input.end } } : undefined,
      }, { size: result.size, sha256: result.sha256 });
      assertLive(job);
      if (a.size !== result.size || a.sha256 !== result.sha256) throw new AppError("invalid_output", "结果内容校验失败");
      return a;
    }));
  }
  function schedule() {
    if (closed) return;
    resolveDependencies();
    mediaQueue.pump();
    language.pump();
    for (const job of store.all("job"))
      if (
        job.executor === 'worker' && ["assigned", "running", "cancel_requested"].includes(job.status) &&
        job.leaseExpires < Date.now()
      ) {
        send(job.workerId, "task.cancel", {}, job);
        job.status = "interrupted";
        job.stage = "执行端失联";
        job.error = "租约已过期，请检查执行端后重试";
        saveJob(job);
      }
    for (const w of store.all("worker")) connectWorker(w);
    for (const w of store.all("worker"))
      if (w.connected && Date.now() - w.lastHeartbeat > 40000) {
        store.put("worker", { ...w, connected: false });
        transport.disconnect(w.id);
        emit("worker.changed");
      }
    for (const job of store
      .all("job")
      .filter((j) => j.status === "queued" && j.executor === 'worker')
      .reverse()) {
      const decision = route(job, store.all('worker'), store.all('job'), wid => peers.get(wid)?.readyState === 1);
      const worker = decision.worker;
      if (!worker) { if (job.waitReason !== decision.reason) saveJob(Object.assign(job, { waitReason: decision.reason, stage: decision.stage })); continue; }
      Object.assign(job, {
        workerId: worker.id,
        resourceIds: worker.deployment.resourceIds,
        waitReason: null,
        status: "assigned",
        stage: "准备执行",
        leaseId: id(),
        leaseExpires: Date.now() + leaseMs,
      });
      saveJob(job);
      store.put('worker', { ...worker, activeAttempts: [job.attemptId] });
      const input = job.input.assetId
        ? {
            ...job.input,
            asset: publicAsset(
              requireValue(store.get("asset", job.input.assetId)),
            ),
          }
        : languageOperations.includes(job.operation) ? { ...job.input, referenceAssets: [] }
        : (isImageOperation(job.operation) || isSpeechOperation(job.operation) || isVideoOperation(job.operation))
          ? { ...job.input, referenceAssets: job.input.referenceAssetIds.map((id: string) => publicAsset(requireValue(store.get("asset", id)))) }
          : job.input;
      send(
        worker.id,
        "task.assign",
        { operation: job.operation, input, leaseSeconds: leaseMs / 1000 },
        job,
      );
    }
  }
  function connectWorker(w: any) {
    transport.connect(w, socket => attachWorker(w.id, socket));
  }
  function attachWorker(workerId: string, socket: WebSocket) {
    const previous = peers.get(workerId);
    peers.set(workerId, socket);
    previous?.close(1000, "Replaced connection");
    let welcomed = false;
    const handshakeTimeout = setTimeout(() => {
      if (!welcomed) socket.close(1008, "Hello timeout");
    }, 5000);
    socket.on("message", async (bytes) => {
      try {
        if (closed || peers.get(workerId) !== socket) return;
        const msg = JSON.parse(bytes.toString());
        if (!validMessage(msg))
          throw new AppError("protocol_invalid", "协议版本或消息结构不兼容");
        const w = requireValue(store.get("worker", workerId));
        if (w.disabled) {
          socket.close(1008, "Revoked");
          return;
        }
        if (msg.type === "hello") {
          if (msg.payload.workerId !== workerId) throw new AppError("worker_identity_changed", "Worker 身份不匹配");
          transport.welcomed(workerId);
          if (
            !Array.isArray(msg.payload.capabilities) ||
            msg.payload.capabilities.some((v: any) => typeof v !== "string")
          )
            throw new AppError("invalid_capabilities", "能力声明无效");
          const deployment = validateDeployment(msg.payload.deployment);
          const specs = msg.payload.executionSpecs;
          if (!Array.isArray(specs) || specs.length > 40 || specs.some((s: any) => !['image', 'speech', 'video', 'language'].includes(s.kind))) throw new AppError('invalid_specs', '执行规格声明无效');
          const languageProfiles = validateLanguageProfiles(specs.filter((s: any) => s.kind === 'language').map((s: any) => s.spec));
          const imageProfiles = validateImageProfiles(specs.filter((s: any) => s.kind === 'image').map((s: any) => s.spec));
          const speechProfiles = validateSpeechProfiles(specs.filter((s: any) => s.kind === 'speech').map((s: any) => s.spec));
          const videoProfiles = validateVideoProfiles(specs.filter((s: any) => s.kind === 'video').map((s: any) => s.spec));
          for (const [kind, profiles] of [['image', imageProfiles], ['speech', speechProfiles], ['video', videoProfiles], ['language', languageProfiles]] as const)
            for (const spec of profiles) store.put('execution-spec', { id: spec.profileId, kind, spec });
          welcomed = true;
          clearTimeout(handshakeTimeout);
          Object.assign(w, {
            connected: true,
            lastHeartbeat: Date.now(),
            imageProfiles, speechProfiles, videoProfiles, languageProfiles, deployment, activeAttempts: msg.payload.activeAttempts,
            capabilities: msg.payload.capabilities.filter((s: string) =>
              (!languageOperations.includes(s) || languageProfiles.some(p => p.operations.includes(s))) && !s.startsWith('media.') && executableOperations.includes(s) && (!isImageOperation(s) || imageProfiles.some(p => p.operations.includes(s))) && (!isSpeechOperation(s) || speechProfiles.length > 0) && (!isVideoOperation(s) || videoProfiles.length > 0),
            ),
          });
          store.put("worker", w);
          const active = store
            .all("job")
            .filter(
              (j) =>
                j.workerId === workerId &&
                !terminal.has(j.status) &&
                j.status !== "queued",
            );
          const running = Array.isArray(msg.payload.activeAttempts)
            ? msg.payload.activeAttempts
            : [];
          for (const j of active)
            if (!running.includes(j.attemptId)) {
              j.status = "interrupted";
              j.stage = "执行端已重启";
              j.error = "Worker 未恢复原任务，请重试";
              saveJob(j);
            } else
              send(
                workerId,
                "lease.renewed",
                {
                  leaseSeconds: Math.max(
                    0,
                    (j.leaseExpires - Date.now()) / 1000,
                  ),
                },
                j,
              );
          send(workerId, "welcome", {
            workerId,
            heartbeatSeconds: 10,
            draining: w.draining,
          });
          emit("worker.changed");
          schedule();
          return;
        }
        if (!welcomed) throw new AppError("hello_required", "请先握手");
        if (msg.type === "heartbeat") {
          Object.assign(w, { connected: true, lastHeartbeat: Date.now(), activeAttempts: msg.payload.activeAttempts || [] });
          store.put("worker", w);
          for (const j of store
            .all("job")
            .filter(
              (j) =>
                j.workerId === workerId &&
                !terminal.has(j.status) &&
                j.status !== "queued",
            )) {
            if (j.leaseExpires < Date.now()) continue;
            j.leaseExpires = Date.now() + leaseMs;
            store.put("job", j);
            send(
              workerId,
              "lease.renewed",
              { leaseSeconds: leaseMs / 1000 },
              j,
            );
            if (j.status === "cancel_requested")
              send(workerId, "task.cancel", {}, j);
          }
          emit("worker.changed");
          return;
        }
        const j = requireValue(store.get("job", msg.jobId));
        if (
          j.workerId !== workerId ||
          j.attemptId !== msg.attemptId ||
          j.leaseId !== msg.leaseId
        )
          throw new AppError("stale_attempt", "忽略过期任务尝试");
        if (j.status === "succeeded" && msg.type === "task.result_ready") {
          send(workerId, "task.commit_ack", { status: j.status }, j);
          return;
        }
        if (terminal.has(j.status) || j.leaseExpires < Date.now()) {
          send(workerId, "task.cancel", {}, j);
          return;
        }
        if (msg.type === "task.cancelled") {
          j.status = "cancelled";
          j.stage = "已停止";
          saveJob(j);
          return;
        }
        if (msg.type === "task.failed") {
          j.status = "failed";
          j.stage = "执行失败";
          j.error = String(msg.payload.message || "执行失败").slice(0, 1000);
          saveJob(j);
          return;
        }
        if (j.status === "cancel_requested") {
          send(workerId, "task.cancel", {}, j);
          return;
        }
        if (msg.type === "task.accepted") {
          j.status = "running";
          j.stage = "传输输入";
          saveJob(j);
          void pushInputs(j);
          return;
        }
        if (msg.type === "task.progress") {
          if (!Number.isInteger(msg.sequence) || msg.sequence <= j.sequence)
            return;
          const p = msg.payload.progress;
          if (p !== null && (!Number.isFinite(p) || p < 0 || p > 1))
            throw new AppError("invalid_progress", "进度不合法");
          j.sequence = msg.sequence;
          j.progress = p;
          j.stage = text(msg.payload.stage, 100);
          saveJob(j);
          return;
        }
        if (msg.type === "task.result_ready") {
          if (downloads.has(j.attemptId)) return;
          downloads.add(j.attemptId);
          let a: any;
          try { a = await pullOutput(j, msg.payload); } finally { downloads.delete(j.attemptId); }
          if (!a || closed) return;
          assertLive(j);
          if (
            a.attemptId !== j.attemptId ||
            a.workerId !== workerId ||
            a.sha256 !== msg.payload.sha256
          )
            throw new AppError("invalid_output", "结果归属或校验不匹配");
          if (
            (isVideoOperation(j.operation) && (a.kind !== "video" || !a.filename.toLowerCase().endsWith(".mp4"))) ||
            (isSpeechOperation(j.operation) && (a.kind !== "audio" || !a.filename.toLowerCase().endsWith(".wav"))) ||
            (isImageOperation(j.operation) && (a.kind !== "image" || !a.filename.toLowerCase().endsWith(".png"))) ||
            ((j.operation === operations[0] || languageOperations.includes(j.operation)) && a.kind !== "text") ||
            (j.operation === operations[1] &&
              (a.kind !== store.get("asset", j.input.assetId)!.kind ||
                a.sha256 !== store.get("asset", j.input.assetId)!.sha256))
          )
            throw new AppError("invalid_output", "执行结果不符合能力契约");
          const outputText = languageOperations.includes(j.operation) ? (a.size > 48000 ? (() => { throw new AppError('output_too_large', '文本结果过大'); })() : validateLanguageOutput(await readFile(assets.path(a), 'utf8'), j.input.schema)) : undefined;
          assertLive(j);
          store.atomic(() => {
            store.put("asset", { ...a, staged: false });
            Object.assign(j, {
              status: "succeeded",
              stage: "已归档",
              progress: 1,
              outputAssetId: a.id,
              ...(outputText !== undefined ? { outputText } : {}),
            });
            recordJob(j);
          });
          emit("job.changed", { id: j.id });
          send(workerId, "task.commit_ack", { status: "succeeded" }, j);
          schedule();
          return;
        }
      } catch (error: any) {
        if (socket.readyState === 1) socket.send(
          JSON.stringify({
            protocolVersion: "3.0",
            messageId: id(),
            type: "error",
            payload: {
              code: error.code || "invalid_message",
              message: error.message,
            },
          }),
        );
      }
    });
    socket.on("close", () => {
      clearTimeout(handshakeTimeout);
      if (closed || peers.get(workerId) !== socket) return;
      peers.delete(workerId);
      const w = store.get("worker", workerId);
      if (w) store.put("worker", { ...w, connected: false });
      emit("worker.changed");
    });
  }
  const adminPath = fileURLToPath(new URL("../admin-dist", import.meta.url));
  if (existsSync(adminPath))
    await app.register(staticFiles, { root: adminPath, prefix: "/admin/" });
  app.get("/", async (_req, reply) => reply.redirect("/admin/"));
  const timer = setInterval(() => {
    schedule();
    for (const [t, expiry] of tickets)
      if (expiry < Date.now()) tickets.delete(t);
  }, options.tickMs || 1000);
  timer.unref();
  app.addHook("onClose", async () => {
    closed = true;
    clearInterval(timer);
    transport.close();
    await mediaQueue.close();
    await language.close();
    for (const s of peers.values()) s.terminate();
    await Promise.allSettled([...pendingTransfers]);
    for (const s of events) s.close();
    store.close();
  });
  app.decorate("store", store);
  return app;
}
