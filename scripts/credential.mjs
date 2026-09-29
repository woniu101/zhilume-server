import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import configModule from '../runtime/config.cjs';
const { dataDirectory } = configModule.resolveRuntimeConfig();
try {
  const token = process.env.ZHILUME_TOKEN || readFileSync(resolve(dataDirectory, 'admin-token'), 'utf8').trim();
  if (!token) throw new Error();
  process.stdout.write(token + '\n');
} catch {
  console.error(`未找到访问凭证。当前数据目录：${dataDirectory}\n请先启动 Server。若使用自定义数据目录，请设置 ZHILUME_DATA 后重试。`);
  process.exitCode = 1;
}
