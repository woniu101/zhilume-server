import type { Store } from './store.js';
import { AppError } from './domain.js';

/** Versioned result target is frozen by Server, never trusted from a client. */
export function resultTarget(node: any, operation: string) {
  if (!node || operation === 'prompt.optimize.v1') return null;
  const d = node.data;
  const expected = operation.startsWith('image.') ? 'image' : operation.startsWith('video.') || operation === 'media.video.trim.v1' ? 'video'
    : operation.startsWith('audio.') || operation === 'media.audio.extract.v1' ? 'audio' : operation === 'mock.media.copy.v1' ? d.kind : 'text';
  if (d.kind !== expected) throw new AppError('result_kind_mismatch', '请先创建与结果类型一致的目标节点');
  return { version: 1, nodeId: node.id, base: { kind: d.kind, assetId: d.assetId, text: d.text, html: d.html, revision: d.contentRevision || 0 } };
}
export function archiveNodeResult(store: Store, job: any) {
  if (job.status !== 'succeeded' || !job.outputAssetId || !job.resultTarget || store.get('node-result', job.id)) return;
  const asset = store.get('asset', job.outputAssetId);
  if (!asset || asset.staged || asset.kind !== job.resultTarget.base.kind) throw new AppError('invalid_node_result', '归档结果与目标节点类型不一致', 409);
  store.put('node-result', { ...job.resultTarget, id: job.id, jobId: job.id, projectId: job.projectId,
    outputAssetId: asset.id, operation: job.operation, createdAt: job.updatedAt });
}
