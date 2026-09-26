import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createApp } from "../src/server.js";
test("desktop and separate web origins can save, rename and remove through preflight", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhilume-cors-"));
  const app = await createApp({ root, token: "cors-test-fixture" });
  t.after(async () => {
    await app.close();
    if (resolve(root).startsWith(resolve(tmpdir()) + sep + "zhilume-cors-"))
      await rm(root, { recursive: true, force: true });
  });
  for (const origin of ["app://zhilume-studio", "http://127.0.0.1:5173"])
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const reply = await app.inject({
        method: "OPTIONS",
        url: "/api/v1/projects/test/canvas",
        headers: {
          origin,
          "access-control-request-method": method,
          "access-control-request-headers": "authorization,content-type",
        },
      });
      assert.equal(reply.statusCode, 204);
      assert.equal(reply.headers["access-control-allow-origin"], origin);
      assert.ok(
        String(reply.headers["access-control-allow-methods"])
          .split(/,\s*/)
          .includes(method),
        `${origin}: ${method} is absent from ${reply.headers["access-control-allow-methods"]}`,
      );
    }
  const denied = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/projects/test/canvas",
    headers: {
      origin: "https://untrusted.example",
      "access-control-request-method": "PUT",
    },
  });
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
});
