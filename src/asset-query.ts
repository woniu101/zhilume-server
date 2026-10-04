import { createHash } from 'node:crypto';
import { AppError } from './domain.js';
import type { Store } from './store.js';

const invalid = () => new AppError('invalid_asset_query', '素材查询参数无效，请重新搜索', 400);
export function assetIds(value: unknown, maximum = 512): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some(v => typeof v !== 'string' || !v || v.length > 100)) throw invalid();
  return [...new Set(value)];
}

/** Keyset pagination holds an insertion boundary; later uploads appear on a new search. */
export function queryAssets(store: Store, input: any) {
  if (!input || !['service', 'canvas', 'library'].includes(input.source)) throw invalid();
  const source = input.source, q = typeof input.q === 'string' ? input.q.trim() : '';
  const kinds = input.kinds ?? ['image', 'video', 'audio', 'text'];
  const limit = input.limit ?? 24;
  if (q.length > 200 || !Array.isArray(kinds) || !kinds.length || kinds.length > 4 || kinds.some(k => !['image','video','audio','text'].includes(k)) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  const ids = source === 'canvas' ? assetIds(input.assetIds ?? [], 10000).sort() : [];
  if (source !== 'service' && (typeof input.projectId !== 'string' || !store.get('project', input.projectId) || store.get('project', input.projectId).trashedAt)) throw new AppError('not_found', '项目不存在', 404);
  const fingerprint = createHash('sha256').update(JSON.stringify([source, input.projectId, q, [...kinds].sort(), ids, limit])).digest('hex');
  let before = Number.MAX_SAFE_INTEGER;
  if (input.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
      if (cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.before) || cursor.before < 1) throw invalid();
      before = cursor.before;
    } catch { throw invalid(); }
  }
  const where = ["a.kind = 'asset'", "COALESCE(json_extract(a.value, '$.staged'), 0) = 0", 'a.rowid < ?', "json_extract(a.value, '$.kind') IN (SELECT value FROM json_each(?))"];
  const params: (string | number)[] = [before, JSON.stringify(kinds)];
  if (source === 'canvas') { where.push('a.id IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(ids)); }
  if (source === 'library') { where.push("EXISTS (SELECT 1 FROM records l WHERE l.kind='library' AND json_extract(l.value,'$.projectId')=? AND json_extract(l.value,'$.assetId')=a.id)"); params.push(input.projectId); }
  if (q) { where.push("(instr(lower(json_extract(a.value,'$.filename')),lower(?)) > 0 OR EXISTS (SELECT 1 FROM records l WHERE l.kind='library' AND json_extract(l.value,'$.assetId')=a.id AND json_extract(l.value,'$.projectId')=? AND instr(lower(json_extract(l.value,'$.name')),lower(?)) > 0))"); params.push(q, input.projectId ?? '', q); }
  const rows = store.db.prepare(`SELECT a.rowid AS rowid, a.value FROM records a WHERE ${where.join(' AND ')} ORDER BY a.rowid DESC LIMIT ?`).all(...params, limit + 1);
  const more = rows.length > limit, page = rows.slice(0, limit);
  return { items: page.map(r => JSON.parse(String(r.value))), nextCursor: more ? Buffer.from(JSON.stringify({ fingerprint, before: Number(page.at(-1)!.rowid) })).toString('base64url') : null };
}
