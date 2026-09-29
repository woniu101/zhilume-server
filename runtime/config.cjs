const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { homedir } = require('node:os');

// Shared by the CLI, credential command and Electron launcher.
function resolveRuntimeConfig(env = process.env, platform = process.platform, home = homedir()) {
  const base = platform === 'win32' ? (env.APPDATA || join(home, 'AppData', 'Roaming'))
    : platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : (env.XDG_CONFIG_HOME || join(home, '.config'));
  const userDirectory = resolve(env.ZHILUME_USER_DATA || join(base, 'zhilume-server'));
  const configFile = join(userDirectory, 'launcher-config.json');
  let saved = {};
  try { saved = JSON.parse(readFileSync(configFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`无法读取启动配置：${configFile}`); }
  const port = Number(env.ZHILUME_PORT || saved.port || 4310);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口应在 1024–65535 之间');
  return {
    userDirectory, configFile, port,
    dataDirectory: resolve(env.ZHILUME_DATA || saved.dataDirectory || join(userDirectory, 'data')),
    closeBehavior: ['ask', 'tray', 'quit'].includes(saved.closeBehavior) ? saved.closeBehavior : 'ask',
  };
}
module.exports = { resolveRuntimeConfig };
