import { createApp } from "./server.js";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const { resolveRuntimeConfig } = createRequire(import.meta.url)("../runtime/config.cjs");
const config = resolveRuntimeConfig();
const root = config.dataDirectory;
const app = await createApp({
  root,
  token: process.env.ZHILUME_TOKEN,
  logger: true,
});
try {
  const address = await app.listen({
    host: process.env.ZHILUME_HOST || "127.0.0.1",
    port: config.port,
  });
  console.log(`管理台：${address}/admin/`);
  console.log(`数据目录：${root}`);
  console.log(process.env.ZHILUME_TOKEN ? "访问凭证：由 ZHILUME_TOKEN 环境变量提供" : `访问凭证文件：${resolve(root, "admin-token")}`);
  console.log("在相同目录与环境运行 npm run credential 查看凭证。日志不会输出凭证内容。");
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
