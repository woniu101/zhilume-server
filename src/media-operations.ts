import { AppError, requireValue, text } from "./domain.js";
import media from '@zhilume/media';

import { readFileSync } from "node:fs";
const catalog = JSON.parse(readFileSync(new URL("../contracts/operation-catalog.json", import.meta.url), "utf8"));
export const mediaCapabilities: { id: string; name: string; simulation: boolean; inputKinds: string[]; outputKind: string; resource: string; version: string }[] = catalog.media;

export function validateMediaInput(operation: string, value: any, asset: any) {
  if (!mediaCapabilities.some(c => c.id === operation) || asset?.kind !== "video" || asset.staged)
    throw new AppError("invalid_input", "此操作需要已归档的视频素材");
  try { return { assetId: asset.id, ...media.validate(operation, value) }; }
  catch (error: any) { throw new AppError(error.code || 'invalid_input', error.message); }
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
