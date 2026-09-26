import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, open } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppError, id, now } from "./domain.js";
import type { Store } from "./store.js";

const types: Record<string, [string, string]> = {
  ".png": ["image", "image/png"],
  ".jpg": ["image", "image/jpeg"],
  ".jpeg": ["image", "image/jpeg"],
  ".webp": ["image", "image/webp"],
  ".mp4": ["video", "video/mp4"],
  ".webm": ["video", "video/webm"],
  ".mov": ["video", "video/quicktime"],
  ".wav": ["audio", "audio/wav"],
  ".mp3": ["audio", "audio/mpeg"],
  ".m4a": ["audio", "audio/mp4"],
  ".txt": ["text", "text/plain; charset=utf-8"],
};
function signature(b: Buffer, ext: string) {
  if (ext === ".txt") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(b, { stream: true });
      return !b.includes(0);
    } catch {
      return false;
    }
  }
  if (ext === ".png")
    return b
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if ([".jpg", ".jpeg"].includes(ext))
    return b[0] === 255 && b[1] === 216 && b[2] === 255;
  if ([".mp4", ".mov", ".m4a"].includes(ext))
    return b.toString("ascii", 4, 8) === "ftyp";
  if (ext === ".webm")
    return b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  if (ext === ".mp3")
    return (
      b.toString("ascii", 0, 3) === "ID3" ||
      (b[0] === 255 && (b[1] & 224) === 224)
    );
  return (
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === (ext === ".wav" ? "WAVE" : "WEBP")
  );
}
export class Assets {
  constructor(
    readonly store: Store,
    readonly secret: string,
    readonly limit: number,
  ) {}
  async ingest(
    stream: NodeJS.ReadableStream,
    filename: string,
    extra: Record<string, unknown> = {},
    expected?: { size: number; sha256: string },
  ) {
    filename = basename(filename.replaceAll("\\", "/")).slice(0, 200);
    const ext = extname(filename).toLowerCase();
    const type = types[ext];
    if (!type)
      throw new AppError("unsupported_media", "当前不支持此文件类型", 415);
    const assetId = id();
    const folder = join(this.store.root, "assets");
    await mkdir(folder, { recursive: true });
    const temporary = join(folder, `${assetId}.upload`);
    const storageKey = `${assetId}${ext}`;
    const final = join(folder, storageKey);
    let size = 0;
    const hash = createHash("sha256");
    const decoder =
      ext === ".txt" ? new TextDecoder("utf-8", { fatal: true }) : null;
    let textLength = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.length;
        if (size > this.limit || (expected && size > expected.size))
          return callback(
            new AppError("upload_too_large", "文件超过上传限制", 413),
          );
        if (decoder) {
          try {
            textLength += decoder.decode(chunk, { stream: true }).length;
          } catch {
            return callback(
              new AppError("invalid_text", "文本必须为 UTF-8 编码", 415),
            );
          }
          if (textLength > 12000)
            return callback(
              new AppError("text_too_large", "文本最多 12,000 字", 413),
            );
        }
        hash.update(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        if (decoder) {
          try {
            decoder.decode();
          } catch {
            return callback(
              new AppError("invalid_text", "文本必须为 UTF-8 编码", 415),
            );
          }
        }
        callback();
      },
    });
    try {
      await pipeline(
        stream,
        meter,
        createWriteStream(temporary, { flags: "wx" }),
      );
      const file = await open(temporary, "r");
      const header = Buffer.alloc(Math.min(size, 4096));
      try {
        await file.read(header, 0, header.length, 0);
      } finally {
        await file.close();
      }
      if (!size || !signature(header, ext))
        throw new AppError("invalid_media", "文件内容与扩展名不匹配", 415);
      const sha256 = hash.digest("hex");
      if (expected && (size !== expected.size || sha256 !== expected.sha256))
        throw new AppError("invalid_output", "输出大小或 SHA-256 不匹配", 422);
      await rename(temporary, final);
      return this.store.put("asset", {
        id: assetId,
        filename,
        kind: type[0],
        mimeType: type[1],
        size,
        sha256,
        storageKey,
        createdAt: now(),
        ...extra,
      });
    } catch (error) {
      await rm(temporary, { force: true });
      await rm(final, { force: true });
      throw error;
    }
  }
  path(asset: any) {
    return join(this.store.root, "assets", asset.storageKey);
  }
  signed(asset: any, download = false) {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const disposition = download ? "download" : "inline";
    const sig = this.sign(`${asset.id}:${expires}:${disposition}`);
    return `/api/v1/assets/${asset.id}/content?expires=${expires}&sig=${sig}&disposition=${disposition}`;
  }
  valid(assetId: string, query: any) {
    if (
      !["download", "inline"].includes(query.disposition) ||
      !Number.isSafeInteger(Number(query.expires)) ||
      Number(query.expires) < Date.now() / 1000 ||
      Number(query.expires) > Date.now() / 1000 + 3601 ||
      typeof query.sig !== "string"
    )
      return false;
    const a = Buffer.from(
      this.sign(`${assetId}:${query.expires}:${query.disposition}`),
    );
    const b = Buffer.from(query.sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  private sign(s: string) {
    return createHmac("sha256", this.secret).update(s).digest("hex");
  }
  decorate(asset: any) {
    const { storageKey, workerId, attemptId, ...safe } = asset;
    return {
      ...safe,
      url: this.signed(asset),
      downloadUrl: this.signed(asset, true),
    };
  }
  async serve(asset: any, req: any, reply: any) {
    const file = this.path(asset);
    const info = await stat(file).catch(() => null);
    if (!info) throw new AppError("asset_missing", "素材文件不存在", 410);
    reply
      .header("Content-Type", asset.mimeType)
      .header("Accept-Ranges", "bytes")
      .header("X-Content-SHA256", asset.sha256)
      .header("Cache-Control", "private, max-age=60")
      .header("X-Content-Type-Options", "nosniff");
    if (req.query.disposition === "download")
      reply.header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
      );
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (!m[1] && !m[2]))
        return reply
          .code(416)
          .header("Content-Range", `bytes */${info.size}`)
          .send();
      const start = m[1] ? Number(m[1]) : Math.max(0, info.size - Number(m[2]));
      const end = m[1]
        ? m[2]
          ? Math.min(Number(m[2]), info.size - 1)
          : info.size - 1
        : info.size - 1;
      if (start >= info.size || end < start || start < 0)
        return reply
          .code(416)
          .header("Content-Range", `bytes */${info.size}`)
          .send();
      reply
        .code(206)
        .header("Content-Range", `bytes ${start}-${end}/${info.size}`)
        .header("Content-Length", end - start + 1);
      return reply.send(createReadStream(file, { start, end }));
    }
    reply.header("Content-Length", info.size);
    return reply.send(createReadStream(file));
  }
}
