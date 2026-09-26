import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createApp } from "../src/server.js";
import { Ajv } from "ajv";

const token = "integration-admin-token";
const headers = { authorization: `Bearer ${token}` };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(
  get: () => Promise<T>,
  condition: (value: T) => boolean,
  timeout = 15000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await get();
    if (condition(value)) return value;
    await pause(100);
  }
  throw new Error("Timed out waiting for state");
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, "exit"), pause(3000)]);
}

test("HTTP persistence, authorization, optimistic revision, immutable assets and idempotency", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhilume-server-test-"));
  let app = await createApp({ root, token });
  t.after(async () => {
    await app.close();
    if (resolve(root).startsWith(resolve(tmpdir()) + "\\zhilume-server-test-"))
      await rm(root, { recursive: true, force: true });
  });
  const req = (method: any, url: string, payload?: any) =>
    app.inject({ method, url, headers, payload });
  await assert.rejects(createApp({ root, token }), /already in use/);
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/v1/projects" })).statusCode,
    401,
  );
  const p = (
    await req("POST", "/api/v1/projects", { name: "测试项目" })
  ).json();
  assert.ok(p.id);
  const doc = {
    schemaVersion: 1,
    baseRevision: 0,
    nodes: [
      {
        id: "n",
        type: "media",
        position: { x: 1, y: 2 },
        data: { kind: "text", title: "test", text: "你好" },
      },
    ],
    edges: [],
  };
  assert.equal(
    (await req("PUT", `/api/v1/projects/${p.id}/canvas`, doc)).statusCode,
    200,
  );
  assert.equal(
    (await req("PUT", `/api/v1/projects/${p.id}/canvas`, doc)).statusCode,
    409,
  );
  const cycle = {
    ...doc,
    baseRevision: 1,
    nodes: [...doc.nodes, { ...doc.nodes[0], id: "b" }],
    edges: [
      { id: "e1", source: "n", target: "b" },
      { id: "e2", source: "b", target: "n" },
    ],
  };
  assert.equal(
    (await req("PUT", `/api/v1/projects/${p.id}/canvas`, cycle)).json().code,
    "cycle",
  );
  const raw = Buffer.from("你好，织镜。");
  const upload = await app.inject({
    method: "POST",
    url: "/api/v1/assets/uploads?filename=test.txt",
    headers: { ...headers, "content-type": "application/octet-stream" },
    payload: raw,
  });
  assert.equal(upload.statusCode, 201, upload.body);
  const asset = upload.json();
  const range = await app.inject({
    method: "GET",
    url: asset.url,
    headers: { range: "bytes=0-5" },
  });
  assert.equal(range.statusCode, 206);
  assert.deepEqual(range.rawPayload, raw.subarray(0, 6));
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: asset.url,
        headers: { range: "bytes=999-" },
      })
    ).statusCode,
    416,
  );
  const entry = (
    await req("POST", `/api/v1/projects/${p.id}/library`, { assetId: asset.id })
  ).json();
  assert.ok(entry.id);
  await req("DELETE", `/api/v1/library/${entry.id}`);
  assert.equal(
    (await app.inject({ method: "GET", url: asset.url })).body,
    raw.toString(),
  );
  const jobBody = {
    requestId: "request-1",
    projectId: p.id,
    nodeId: "n",
    operation: "mock.text.echo.v1",
    input: { text: "你好" },
  };
  const j = (await req("POST", "/api/v1/jobs", jobBody)).json();
  assert.equal(j.status, "queued");
  assert.equal((await req("POST", "/api/v1/jobs", jobBody)).json().id, j.id);
  assert.equal(
    (await req("POST", "/api/v1/jobs", { ...jobBody, input: { text: "不同" } }))
      .statusCode,
    409,
  );
  assert.equal(
    (await req("POST", `/api/v1/jobs/${j.id}/cancel`)).json().status,
    "cancelled",
  );
  assert.equal(
    (
      await req("POST", "/api/v1/jobs", {
        requestId: "bad",
        projectId: p.id,
        operation: "mock.media.copy.v1",
        input: {},
      })
    ).statusCode,
    404,
  );
  const registration = (await req("POST", "/api/v1/enrollments")).json();
  const registrationPayload = {
    token: registration.token,
    name: "worker-test",
    platform: "test",
  };
  const worker = (
    await app.inject({
      method: "POST",
      url: "/api/v1/workers/register",
      payload: registrationPayload,
    })
  ).json();
  assert.ok(worker.credential);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/workers/register",
        payload: registrationPayload,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${worker.credential}` },
      })
    ).statusCode,
    403,
  );
  await app.close();
  app = await createApp({ root, token });
  assert.equal(
    (await req("GET", `/api/v1/projects/${p.id}/canvas`)).json().revision,
    1,
  );
  assert.equal((await req("GET", "/api/v1/assets")).json().length, 1);
});

test(
  "real Python Worker completes text and media jobs, cancellation and restart/retry",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zhilume-worker-test-"));
    const app = await createApp({
      root: join(root, "server"),
      token,
      tickMs: 50,
      leaseMs: 2500,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as any;
    const base = `http://127.0.0.1:${address.port}`;
    let child: ChildProcess | undefined;
    let output = "";
    t.after(async () => {
      if (child) await stop(child);
      await app.close();
      if (
        resolve(root).startsWith(resolve(tmpdir()) + "\\zhilume-worker-test-")
      )
        await rm(root, { recursive: true, force: true });
    });
    const api = async (path: string, method = "GET", body?: any) => {
      const response = await fetch(base + "/api/v1" + path, {
        method,
        headers: {
          ...headers,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result;
    };
    const p = await api("/projects", "POST", { name: "协议端到端" });
    const enrollment = await api("/enrollments", "POST");
    const launch = (delay: string, enroll = false) => {
      const c = spawn(
        process.env.ZHILUME_TEST_PYTHON ||
          resolve(
            "../zhilume-worker/.venv/" +
              (process.platform === "win32"
                ? "Scripts/python.exe"
                : "bin/python"),
          ),
        [
          "-m",
          "zhilume_worker",
          "--server",
          base,
          "--state",
          join(root, "worker"),
          "--delay",
          delay,
          ...(enroll ? ["--enrollment", enrollment.token] : []),
        ],
        {
          cwd: process.env.ZHILUME_TEST_PYTHON
            ? process.cwd()
            : resolve("../zhilume-worker"),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      c.stdout?.on("data", (b) => (output += b.toString()));
      c.stderr?.on("data", (b) => (output += b.toString()));
      return c;
    };
    child = launch(".1", true);
    await waitFor(
      () => api("/workers"),
      (w) => w.some((x: any) => x.connected),
      15000,
    ).catch((e) => {
      throw new Error(e.message + "\n" + output);
    });
    const submit = (operation: string, input: any) =>
      api("/jobs", "POST", {
        projectId: p.id,
        requestId: crypto.randomUUID(),
        operation,
        input,
      });
    const text = await submit("mock.text.echo.v1", { text: "织镜端到端 ✓" });
    const textDone = await waitFor(
      () => api(`/jobs/${text.id}`),
      (j) => j.status === "succeeded",
    );
    assert.equal(
      await fetch(base + textDone.output.url).then((r) => r.text()),
      "织镜端到端 ✓",
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=",
      "base64",
    );
    const upload = await fetch(
      base + "/api/v1/assets/uploads?filename=test.png",
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/octet-stream" },
        body: png,
      },
    );
    assert.equal(upload.status, 201);
    const asset = (await upload.json()) as any;
    const media = await submit("mock.media.copy.v1", { assetId: asset.id });
    const done = await waitFor(
      () => api(`/jobs/${media.id}`),
      (j) => j.status === "succeeded",
    );
    assert.equal(
      done.output.sha256,
      createHash("sha256").update(png).digest("hex"),
    );
    for (const filename of ["interaction-test.mp4", "interaction-test.wav"]) {
      const bytes = await readFile(join("tests/fixtures", filename));
      const response = await fetch(
        base + "/api/v1/assets/uploads?filename=" + filename,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/octet-stream" },
          body: bytes,
        },
      );
      assert.equal(response.status, 201);
      const input = (await response.json()) as any;
      const mediaJob = await submit("mock.media.copy.v1", {
        assetId: input.id,
      });
      const result = await waitFor(
        () => api(`/jobs/${mediaJob.id}`),
        (j) => j.status === "succeeded",
      );
      assert.equal(
        result.output.sha256,
        createHash("sha256").update(bytes).digest("hex"),
      );
      assert.equal(result.output.size, bytes.length);
    }
    await stop(child);
    child = launch("10");
    await waitFor(
      () => api("/workers"),
      (w) => w.some((x: any) => x.connected),
    );
    const cancel = await submit("mock.text.echo.v1", { text: "取消测试" });
    await waitFor(
      () => api(`/jobs/${cancel.id}`),
      (j) => j.status === "running",
    );
    await api(`/jobs/${cancel.id}/cancel`, "POST");
    const cancelled = await waitFor(
      () => api(`/jobs/${cancel.id}`),
      (j) => j.status === "cancelled",
    );
    assert.equal(cancelled.output, null);
    const interrupted = await submit("mock.text.echo.v1", {
      text: "中断后重试",
    });
    await waitFor(
      () => api(`/jobs/${interrupted.id}`),
      (j) => j.status === "running",
    );
    await stop(child);
    await waitFor(
      () => api(`/jobs/${interrupted.id}`),
      (j) => j.status === "interrupted",
    );
    child = launch(".1");
    await waitFor(
      () => api("/workers"),
      (w) => w.some((x: any) => x.connected),
    );
    const retry = await api(`/jobs/${interrupted.id}/retry`, "POST");
    assert.notEqual(retry.attemptId, interrupted.attemptId);
    const retried = await waitFor(
      () => api(`/jobs/${interrupted.id}`),
      (j) => j.status === "succeeded",
    );
    assert.equal(retried.attempts.length, 1);
  },
);

test("contract fixtures and exported snapshots have identical hashes", async () => {
  const source = await readFile("contracts/worker-message.schema.json");
  const schema = JSON.parse(source.toString());
  const validate = new Ajv({ strict: false }).compile(schema);
  const fixtures = JSON.parse(
    await readFile("contracts/fixtures.json", "utf8"),
  );
  for (const entry of fixtures.valid)
    assert.equal(validate(entry), true, JSON.stringify(validate.errors));
  for (const entry of fixtures.invalid) assert.equal(validate(entry), false);
  for (const path of [
    "../zhilume-worker/src/zhilume_worker/contracts",
    "../zhilume-studio/src/contracts",
  ]) {
    assert.deepEqual(
      await readFile(join(path, "worker-message.schema.json")),
      source,
    );
    const manifest = JSON.parse(await readFile("contracts/manifest.json", "utf8"));
    assert.deepEqual(JSON.parse(await readFile(join(path, "manifest.json"), "utf8")), manifest);
    for (const [name, hash] of Object.entries(manifest.files)) {
      assert.equal(createHash("sha256").update(await readFile(join(path, name))).digest("hex"), hash);
      assert.equal(createHash("sha256").update(await readFile(join("contracts", name))).digest("hex"), hash);
    }
  }
});
