import { AppError, requireValue, text } from "./domain.js";

import { readFileSync } from "node:fs";
const catalog = JSON.parse(readFileSync(new URL("../contracts/operation-catalog.json", import.meta.url), "utf8"));
export const mediaCapabilities: { id: string; name: string; simulation: boolean; inputKinds: string[]; outputKind: string; resource: string; version: string }[] = catalog.media;

export function validateMediaInput(operation: string, value: any, asset: any) {
  if (!mediaCapabilities.some(c => c.id === operation) || asset?.kind !== "video" || asset.staged)
    throw new AppError("invalid_input", "此操作需要已归档的视频素材");
  const start = value?.start, end = value?.end;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 86400)
    throw new AppError("invalid_range", "开始和结束时间必须在 0 至 86400 秒之间，且结束晚于开始");
  return { assetId: asset.id, start, end };
}

export function validateProvenance(raw: unknown, lookup: (id: string) => any) {
  if (raw === undefined) return undefined;
  let value: any;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { throw new AppError("invalid_provenance", "素材来源信息格式错误"); }
  const allowed = ["image.crop.v1", "image.collage.v1", "image.grid.v1", ...mediaCapabilities.map(c => c.id)];
  if (!value || !allowed.includes(value.operation) || !Array.isArray(value.sourceAssetIds) ||
      !value.sourceAssetIds.length || value.sourceAssetIds.length > 16 ||
      !value.parameters || typeof value.parameters !== "object" || Array.isArray(value.parameters) ||
      JSON.stringify(value.parameters).length > 4096)
    throw new AppError("invalid_provenance", "素材来源信息不合法");
  const sourceAssetIds = value.sourceAssetIds.map((id: unknown) => {
    const asset = requireValue(lookup(text(id, 100)), "来源素材不存在");
    if (asset.staged) throw new AppError("invalid_provenance", "来源素材尚未归档");
    return asset.id;
  });
  return { operation: value.operation, sourceAssetIds, parameters: value.parameters };
}

// Planned models are deliberately separate from executable Worker capabilities.
