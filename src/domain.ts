import { validateVideoDraft } from './video-operations.js';
import { validateSpeechDraft } from './speech-operations.js';
import { validateGenerationDraft } from "./generation-draft.js";
import { randomUUID } from "node:crypto";
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const terminal = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "blocked",
]);
export const operations = ["mock.text.echo.v1", "mock.media.copy.v1"];
export const capabilities = [
  {
    id: operations[0],
    name: "文本回显测试",
    simulation: true,
    inputKinds: ["text"],
    version: "1.0",
  },
  {
    id: operations[1],
    name: "素材复制测试",
    simulation: true,
    inputKinds: ["image", "video", "audio"],
    version: "1.0",
  },
];
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
export function requireValue(value: any, message = "记录不存在"): any {
  if (!value) throw new AppError("not_found", message, 404);
  return value;
}
export function text(value: unknown, max = 12000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new AppError("invalid_input", "文本为空或超过允许长度");
  return value.trim();
}
export function validateCanvas(doc: any) {
  if (
    doc?.viewport !== undefined &&
    (!Number.isFinite(doc.viewport?.x) ||
      !Number.isFinite(doc.viewport?.y) ||
      !Number.isFinite(doc.viewport?.zoom) ||
      doc.viewport.zoom < 0.15 ||
      doc.viewport.zoom > 2.5)
  )
    throw new AppError("invalid_viewport", "画布视角不合法");
  if (
    doc?.schemaVersion !== 1 ||
    !Array.isArray(doc.nodes) ||
    !Array.isArray(doc.edges) ||
    doc.nodes.length > 1000 ||
    doc.edges.length > 5000
  )
    throw new AppError("invalid_canvas", "不支持的画布版本或结构");
  const nodeIds = new Set<string>();
  for (const node of doc.nodes) {
    if (
      typeof node.id !== "string" ||
      nodeIds.has(node.id) ||
      !["media", "group"].includes(node.type) ||
      !Number.isFinite(node.position?.x) ||
      !Number.isFinite(node.position?.y)
    )
      throw new AppError("invalid_node", "节点 ID、类型或位置不合法");
    if (
      node.type === "media" &&
      !["text", "image", "video", "audio"].includes(node.data?.kind)
    )
      throw new AppError("invalid_node_kind", "不支持的内容类型");
    if (
      typeof node.data?.title !== "string" ||
      node.data.title.length > 200 ||
      (node.data.text !== undefined &&
        (typeof node.data.text !== "string" || node.data.text.length > 12000))
    )
      throw new AppError("invalid_node_content", "节点标题或文本超过允许长度");
    const data = node.data;
    if (data.languageSelection !== undefined) {
      const d = data.languageSelection, string = (v:unknown,n:number) => typeof v === 'string' && v.length <= n;
      if (!d || !string(d.profileId,100) || !string(d.targetWorkerId,100) ||
          (d.request !== undefined && (!string(d.request?.id,100) || !string(d.request?.fingerprint,32000))))
        throw new AppError('invalid_language_selection', '语言模型选择或请求记录不合法');
    }

    if (data.contentSchemaVersion !== undefined && data.contentSchemaVersion !== 1)
      throw new AppError('unsupported_content_version', '不支持的节点内容版本');
    if (data.contentRevision !== undefined && (!Number.isSafeInteger(data.contentRevision) || data.contentRevision < 0))
      throw new AppError('invalid_content_revision', '内容版本号不合法');
    if (data.titleSource !== undefined && !['automatic', 'custom'].includes(data.titleSource))
      throw new AppError('invalid_node_content', '节点名称来源不合法');
    if (data.versions !== undefined) {
      if (!Array.isArray(data.versions) || data.versions.length > 1000) throw new AppError('invalid_versions', '节点历史最多 1000 个版本');
      const ids = new Set();
      for (const v of data.versions) {
        if (!v || typeof v.id !== 'string' || !v.id || v.id.length > 100 || ids.has(v.id) ||
            !['text','image','video','audio'].includes(v.kind) || !Number.isSafeInteger(v.revision) || v.revision < 0 ||
            typeof v.createdAt !== 'string' || !Number.isFinite(Date.parse(v.createdAt)) ||
            typeof v.operation !== 'string' || v.operation.length > 100 ||
            (v.assetId !== undefined && (typeof v.assetId !== 'string' || v.assetId.length > 100)) ||
            (v.text !== undefined && (typeof v.text !== 'string' || v.text.length > 12000)) ||
            (v.html !== undefined && (typeof v.html !== 'string' || v.html.length > 100000)))
          throw new AppError('invalid_versions', '节点历史结构不合法');
        ids.add(v.id);
      }
    }
    if (data.receivedResultIds !== undefined && (!Array.isArray(data.receivedResultIds) || data.receivedResultIds.length > 10000 || data.receivedResultIds.some((v:any) => typeof v !== 'string' || v.length > 100)))
      throw new AppError('invalid_results', '节点结果确认记录不合法');
    for (const draft of [data.generationDraft, data.speechDraft, data.videoDraft])
      if (draft?.targetWorkerId !== undefined && (typeof draft.targetWorkerId !== 'string' || draft.targetWorkerId.length > 100))
        throw new AppError('invalid_target', '执行端选择不合法');
    if (node.data.videoDraft !== undefined) validateVideoDraft(node.data.videoDraft);
    if (node.data.speechDraft !== undefined) validateSpeechDraft(node.data.speechDraft);
    if (node.data.generationDraft !== undefined) validateGenerationDraft(node.data.generationDraft);
    for (const field of ["textDraft", "textEditDraft"])
      if (node.data[field] !== undefined && (typeof node.data[field] !== "string" || node.data[field].length > 12000))
        throw new AppError("invalid_node_content", "文本草稿超过允许长度");
    nodeIds.add(node.id);
  }
  const children = new Map<string, string[]>();
  const edgeIds = new Set();
  const pairs = new Set();
  for (const edge of doc.edges) {
    const key = `${edge.source}:${edge.target}`;
    if (
      !nodeIds.has(edge.source) ||
      !nodeIds.has(edge.target) ||
      edge.source === edge.target ||
      edgeIds.has(edge.id) ||
      pairs.has(key)
    )
      throw new AppError("invalid_edge", "连线有重复或无效引用");
    edgeIds.add(edge.id);
    pairs.add(key);
    children.set(edge.source, [
      ...(children.get(edge.source) || []),
      edge.target,
    ]);
  }
  const visiting = new Set();
  const done = new Set();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new AppError("cycle", "引用关系不能形成循环");
    if (done.has(key)) return;
    visiting.add(key);
    for (const next of children.get(key) || []) visit(next);
    visiting.delete(key);
    done.add(key);
  };
  for (const key of nodeIds) visit(key);
  for (const node of doc.nodes)
    if (
      node.parentId &&
      (!nodeIds.has(node.parentId) ||
        node.parentId === node.id ||
        doc.nodes.find((n: any) => n.id === node.parentId)?.type !== "group" ||
        node.type === "group")
    )
      throw new AppError("invalid_group", "分组关系不合法");
}
