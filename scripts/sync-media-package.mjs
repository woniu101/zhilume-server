// One canonical implementation, versioned npm artifacts for independent repositories.
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor'); mkdirSync(vendor, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw Error('请通过 npm run media:sync -- <Studio 仓库目录> 运行');
const result = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', vendor], { cwd: join(root, 'packages/media'), encoding: 'utf8' }));
const file = join(vendor, result[0].filename);
if (process.argv[2]) {
  const destination = resolve(process.argv[2], 'vendor'); mkdirSync(destination, { recursive: true });
  copyFileSync(file, join(destination, result[0].filename));
}
console.log(result[0].filename, createHash('sha256').update(readFileSync(file)).digest('hex'));
