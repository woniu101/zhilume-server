import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCanvas } from "../src/domain.js";
import { workerStatus } from "../src/worker-status.js";

test("generation drafts retain incomplete fields while rejecting oversized or malformed state", () => {
  const draft = { operation: "image.generate.v1", modelId: "qwen-image-2512", profileId: "", prompt: "", negative: "",
    refs: [], format: "png", width: 0, height: 1024, steps: "", seed: "", sizeMode: "custom" };
  const document = (generationDraft: unknown) => ({ schemaVersion: 1, nodes: [{ id: "n", type: "media", position: { x: 0, y: 0 }, data: { kind: "image", title: "图片", generationDraft } }], edges: [] });
  assert.doesNotThrow(() => validateCanvas(document(draft)));
  assert.throws(() => validateCanvas(document({ ...draft, prompt: "x".repeat(12001) })), /草稿/);
  assert.throws(() => validateCanvas(document({ ...draft, refs: ["a", "a"] })), /草稿/);
  assert.doesNotThrow(() => validateCanvas(document({ ...draft, refs: Array.from({ length: 11 }, (_, i) => String(i)) })));
  assert.throws(() => validateCanvas(document({ ...draft, refs: Array.from({ length: 1001 }, (_, i) => String(i)) })), /草稿/);
  assert.throws(() => validateCanvas(document({ ...draft, request: { id: "retry", seed: -1, fingerprint: "x" } })), /草稿/);
});

test("worker diagnostics distinguish busy, draining, disabled and stale connections", () => {
  const now = 100000, worker = { id: "w", connected: true, lastHeartbeat: 99000 };
  assert.equal(workerStatus(worker, [], now).state, "ready");
  const job = { id: "j", workerId: "w", status: "running", stage: "采样" };
  assert.deepEqual(workerStatus(worker, [job], now).activeJobs, [{ id: "j", status: "running", stage: "采样" }]);
  assert.equal(workerStatus(worker, [job], now).state, "busy");
  assert.equal(workerStatus({ ...worker, draining: true }, [job], now).state, "draining");
  assert.equal(workerStatus({ ...worker, disabled: true }, [job], now).state, "disabled");
  assert.equal(workerStatus(worker, [], now + 40000).state, "offline");
});


test("text body edit drafts and generation prompts are independently bounded", () => {
  const document = (data: Record<string, unknown>) => ({ schemaVersion: 1, nodes: [{ id: "text", type: "media", position: { x: 0, y: 0 }, data: { kind: "text", title: "文本", text: "已保存正文", ...data } }], edges: [] });
  assert.doesNotThrow(() => validateCanvas(document({ textDraft: "生成要求", textEditDraft: "待保存正文" })));
  for (const key of ["textDraft", "textEditDraft"]) {
    assert.doesNotThrow(() => validateCanvas(document({ [key]: "" })));
    assert.doesNotThrow(() => validateCanvas(document({ [key]: "x".repeat(12000) })));
    assert.throws(() => validateCanvas(document({ [key]: "x".repeat(12001) })), /草稿/);
    assert.throws(() => validateCanvas(document({ [key]: 123 })), /草稿/);
  }
});
