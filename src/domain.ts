import { randomUUID } from "node:crypto";
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const terminal = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
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
