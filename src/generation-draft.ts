import { AppError } from "./domain.js";

/** Draft validation is deliberately independent of online model availability. */
export function validateGenerationDraft(d: any) {
  const string = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  if (!d || typeof d !== "object" || Array.isArray(d) ||
      !["image.generate.v1", "image.edit.v1", "image.reference.v1"].includes(d.operation) ||
      !["qwen-image-2512", "qwen-image-2.1"].includes(d.modelId) ||
      !string(d.profileId, 64) || !string(d.prompt, 12000) || !string(d.negative, 12000) ||
      !["ratio", "custom"].includes(d.sizeMode) || !["png", "rgba"].includes(d.format) ||
      !string(d.steps, 20) || !string(d.seed, 30) ||
      ![d.width, d.height].every(n => Number.isFinite(n) && Math.abs(n) <= 1000000) ||
      !Array.isArray(d.refs) || d.refs.length > 16 || new Set(d.refs).size !== d.refs.length ||
      d.refs.some((id: unknown) => !string(id, 100) || !id) ||
      (d.request !== undefined && (!string(d.request?.fingerprint, 32000) || !string(d.request?.id, 100) || !d.request.id || !Number.isSafeInteger(d.request?.seed) || d.request.seed < 0)))
    throw new AppError("invalid_generation_draft", "生成草稿结构或长度不合法");
}
