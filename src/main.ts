import { createApp } from "./server.js";
import { resolve } from "node:path";
const app = await createApp({
  root: resolve(process.env.ZHILUME_DATA || ".data"),
  token: process.env.ZHILUME_TOKEN,
  logger: true,
});
try {
  await app.listen({
    host: process.env.ZHILUME_HOST || "127.0.0.1",
    port: Number(process.env.ZHILUME_PORT || 4310),
  });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
