import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createApp } from "../src/server.js";
import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";
import { once } from "node:events";
const token = "refinement-local-test",
  headers = { authorization: `Bearer ${token}` };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("admin surface identity, viewport roundtrip and non-destructive folder management", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhilume-refinements-")),
    app = await createApp({ root, token });
  t.after(async () => {
    await app.close();
    if (
      resolve(root).startsWith(resolve(tmpdir()) + sep + "zhilume-refinements-")
    )
      await rm(root, { recursive: true, force: true });
  });
  const req = (method: any, url: string, payload?: any) =>
    app.inject({ method, url: "/api/v1" + url, headers, payload });
  const admin = await app.inject("/admin/");
  assert.equal(admin.statusCode, 200);
  assert.match(admin.body, /content="server-admin"/);
  assert.match(admin.body, /Zhilume Server/);
  const p = (await req("POST", "/projects", { name: "folders" })).json();
  const a = (
    await req("POST", `/projects/${p.id}/folders`, { name: "A" })
  ).json();
  const b = (
    await req("POST", `/projects/${p.id}/folders`, {
      name: "B",
      parentId: a.id,
    })
  ).json();
  assert.equal(
    (await req("PATCH", `/folders/${a.id}`, { parentId: b.id })).json().code,
    "folder_cycle",
  );
  const item = (
    await req("POST", `/projects/${p.id}/library`, {
      text: "preserved",
      folderId: a.id,
    })
  ).json();
  await req("PATCH", `/folders/${a.id}`, { name: "renamed" });
  assert.equal((await req("DELETE", `/folders/${a.id}`)).statusCode, 204);
  const lib = (await req("GET", `/projects/${p.id}/library`)).json();
  assert.equal(lib.items[0].assetId, item.assetId);
  assert.equal(lib.items[0].folderId, null);
  assert.equal(lib.folders[0].parentId, null);
  const doc = {
    schemaVersion: 1,
    baseRevision: 0,
    nodes: [],
    edges: [],
    viewport: { x: 33, y: -90, zoom: 0.6 },
  };
  assert.equal(
    (await req("PUT", `/projects/${p.id}/canvas`, doc)).statusCode,
    200,
  );
  assert.deepEqual(
    (await req("GET", `/projects/${p.id}/canvas`)).json().viewport,
    doc.viewport,
  );
  assert.equal(
    (
      await req("PUT", `/projects/${p.id}/canvas`, {
        ...doc,
        baseRevision: 1,
        viewport: { ...doc.viewport, zoom: 0 },
      })
    ).json().code,
    "invalid_viewport",
  );
});
test("two workers receive separate jobs and stale attempts cannot alter a retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhilume-concurrency-")),
    app = await createApp({ root, token, tickMs: 30, leaseMs: 15000 });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`,
    sockets: WebSocket[] = [], listeners: ReturnType<typeof createServer>[] = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    for (const listener of listeners) await new Promise<void>(r => listener.close(() => r()));
    await app.close();
    if (
      resolve(root).startsWith(resolve(tmpdir()) + sep + "zhilume-concurrency-")
    )
      await rm(root, { recursive: true, force: true });
  });
  const api = async (path: string, method = "GET", body?: any) => {
    const r = await fetch(base + "/api/v1" + path, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await r.json();
    assert.ok(r.ok, JSON.stringify(result));
    return result as any;
  };
  const wait = async (get: () => any, condition: (v: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const v = await get();
      if (condition(v)) return v;
      await pause(50);
    }
    throw new Error("state timeout");
  };
  const peers: any[] = [];
  for (let i = 0; i < 2; i++) {
    const workerId = crypto.randomUUID(), credential = "test-worker-credential-" + i;
    const listener = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer " + credential) { res.writeHead(401).end(); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ name: "Zhilume Worker", workerId, workerName: "test" + i, platform: "test", protocolVersion: "2.0" }));
    });
    const wss = new WebSocketServer({ server: listener });
    listener.listen(0, "127.0.0.1"); await once(listener, "listening"); listeners.push(listener);
    const incoming = once(wss, "connection");
    const worker = await api("/workers", "POST", { address: `http://127.0.0.1:${(listener.address() as any).port}`, credential });
    const [ws] = await incoming as [WebSocket];
    sockets.push(ws);
    const messages: any[] = [];
    ws.on("message", (b) => messages.push(JSON.parse(b.toString())));
    const send = (
      type: string,
      payload: any = {},
      job?: any,
      sequence?: number,
    ) =>
      ws.send(
        JSON.stringify({
          protocolVersion: "2.0",
          messageId: crypto.randomUUID(),
          type,
          payload,
          ...(job
            ? {
                jobId: job.jobId || job.id,
                attemptId: job.attemptId,
                leaseId: job.leaseId,
              }
            : {}),
          ...(sequence === undefined ? {} : { sequence }),
        }),
      );
    send("hello", { workerId, capabilities: ["mock.text.echo.v1"], activeAttempts: [] });
    await wait(
      () => messages,
      (m) => m.some((x: any) => x.type === "welcome"),
    );
    peers.push({ messages, send, worker });
  }
  const p = await api("/projects", "POST", { name: "concurrency" });
  const jobs = [];
  for (let i = 0; i < 2; i++)
    jobs.push(
      await api("/jobs", "POST", {
        projectId: p.id,
        requestId: crypto.randomUUID(),
        operation: "mock.text.echo.v1",
        input: { text: "concurrent" + i },
      }),
    );
  const assignments = [];
  for (const peer of peers) {
    const message = await wait(
      () => peer.messages.find((m: any) => m.type === "task.assign"),
      Boolean,
    );
    assignments.push(message);
    peer.send("task.accepted", {}, message);
  }
  assert.notEqual(assignments[0].jobId, assignments[1].jobId);
  for (const job of jobs)
    await wait(
      () => api("/jobs/" + job.id),
      (j) => j.status === "running",
    );
  const peer = peers[0],
    old = assignments[0];
  peer.send("task.failed", { message: "injected failure" }, old);
  await wait(
    () => api("/jobs/" + old.jobId),
    (j) => j.status === "failed",
  );
  const retry = await api("/jobs/" + old.jobId + "/retry", "POST");
  assert.notEqual(retry.attemptId, old.attemptId);
  const newer = await wait(
    () =>
      peer.messages.find(
        (m: any) => m.type === "task.assign" && m.attemptId === retry.attemptId,
      ),
    Boolean,
  );
  peer.send("task.progress", { stage: "stale", progress: 0.99 }, old, 9);
  await wait(
    () => peer.messages,
    (m) =>
      m.some(
        (x: any) => x.type === "error" && x.payload.code === "stale_attempt",
      ),
  );
  const unchanged = await api("/jobs/" + old.jobId);
  assert.notEqual(unchanged.stage, "stale");
  assert.equal(unchanged.attemptId, retry.attemptId);
  peer.send("task.accepted", {}, newer);
  await wait(
    () => api("/jobs/" + old.jobId),
    (j) => j.status === "running",
  );
});
