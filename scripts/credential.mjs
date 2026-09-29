import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
try {
  const token = process.env.ZHILUME_TOKEN || readFileSync(resolve(process.env.ZHILUME_DATA || '.data', 'admin-token'), 'utf8').trim();
  if (!token) throw new Error();
  process.stdout.write(token + '\n');
} catch {
  console.error('未找到访问凭证。请先启动 Server，并使用相同的 ZHILUME_DATA 配置运行此命令。');
  process.exitCode = 1;
}
