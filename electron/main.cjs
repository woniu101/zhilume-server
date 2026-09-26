const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  clipboard,
  Tray,
  Menu,
} = require("electron");
const { spawn } = require("node:child_process");
const { join, resolve } = require("node:path");
const {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} = require("node:fs");
let window,
  adminWindow,
  tray,
  child = null,
  logs = [],
  stopping = false,
  quitting = false,
  ready = false;
let config = { port: 4310, dataDirectory: "" };
const address = () => `http://127.0.0.1:${config.port}`;
const icon = join(__dirname, "../assets/icon.ico");
const configFile = () => join(app.getPath("userData"), "launcher-config.json");
const tokenFile = () => join(config.dataDirectory, "admin-token");
if (process.env.ZHILUME_USER_DATA)
  app.setPath("userData", resolve(process.env.ZHILUME_USER_DATA));
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  window?.show();
  window?.focus();
});
function snapshot() {
  return {
    running: !!child,
    ready,
    address: address(),
    port: config.port,
    dataDirectory: config.dataDirectory,
    logs: logs.slice(-100),
  };
}
function publish() {
  if (window && !window.isDestroyed())
    window.webContents.send("server:state", snapshot());
}
function record(line) {
  logs.push(line.replace(/[\r\n]+$/, ""));
  if (logs.length > 200) logs.shift();
  publish();
}
function credential() {
  if (!child || !ready || !existsSync(tokenFile()))
    throw new Error("请先启动 Server 并等待就绪");
  return readFileSync(tokenFile(), "utf8").trim();
}
async function verifyAdmin() {
  credential();
  const response = await fetch(address() + "/admin/", {
    signal: AbortSignal.timeout(3000),
    cache: "no-store",
  });
  if (
    !response.ok ||
    !(await response.text()).includes('content="server-admin"')
  )
    throw new Error("此服务未提供 Zhilume Server 管理台，请检查端口和发布文件");
}
async function openAdmin() {
  await verifyAdmin();
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.show();
    adminWindow.focus();
    return;
  }
  adminWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 850,
    minHeight: 640,
    title: "Zhilume Server 管理台",
    icon,
    autoHideMenuBar: true,
    backgroundColor: "#141414",
    webPreferences: {
      preload: join(__dirname, "admin-preload.cjs"),
      partition: "zhilume-server-admin",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const target = adminWindow;
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  target.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(address() + "/admin/")) event.preventDefault();
  });
  target.on("closed", () => {
    if (adminWindow === target) adminWindow = null;
  });
  await target.loadURL(address() + "/admin/");
}
async function start() {
  if (child) return snapshot();
  try {
    const response = await fetch(address() + "/api/v1/system", {
      signal: AbortSignal.timeout(800),
    });
    if (response)
      throw new Error(
        `${config.port} 端口已有服务运行，请停止已有服务或更换端口`,
      );
  } catch (e) {
    if (e.message.includes("已有服务")) throw e;
  }
  ready = false;
  const owned = spawn(
    process.execPath,
    [resolve(__dirname, "../dist/main.js")],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ZHILUME_DATA: config.dataDirectory,
        ZHILUME_HOST: "127.0.0.1",
        ZHILUME_PORT: String(config.port),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child = owned;
  owned.stdout.on("data", (b) => record(b.toString()));
  owned.stderr.on("data", (b) => record(b.toString()));
  owned.on("error", (e) => record("启动失败：" + e.message));
  owned.on("exit", (code) => {
    if (child === owned) {
      child = null;
      ready = false;
    }
    record("服务已停止，退出码 " + code);
  });
  record("正在启动独立 Server 进程…");
  for (let i = 0; i < 40 && child === owned; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      if (!existsSync(tokenFile())) continue;
      const response = await fetch(address() + "/api/v1/stats", {
        headers: {
          Authorization: "Bearer " + readFileSync(tokenFile(), "utf8").trim(),
        },
        signal: AbortSignal.timeout(700),
      });
      if (response.ok) {
        ready = true;
        record("Server 已就绪，管理台 " + address() + "/admin/");
        break;
      }
    } catch {}
  }
  if (child === owned && !ready)
    record("服务尚未就绪，请检查日志、端口及数据目录。");
  return snapshot();
}
async function stop() {
  if (!child || stopping) return snapshot();
  stopping = true;
  try {
    if (ready)
      try {
        const response = await fetch(address() + "/api/v1/stats", {
          headers: { Authorization: "Bearer " + credential() },
          signal: AbortSignal.timeout(1500),
        });
        const stats = await response.json();
        if (stats.running > 0) {
          const answer = await dialog.showMessageBox(window, {
            type: "warning",
            buttons: ["继续运行", "停止服务"],
            defaultId: 0,
            cancelId: 0,
            message: `当前有 ${stats.running} 个任务执行中，停止服务会中断连接。`,
          });
          if (answer.response === 0) return snapshot();
        }
      } catch {}
    const owned = child;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3500);
      owned.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      owned.kill();
    });
    if (!child && adminWindow && !adminWindow.isDestroyed())
      adminWindow.close();
    return snapshot();
  } finally {
    stopping = false;
  }
}
async function quit() {
  await stop();
  if (!child) {
    quitting = true;
    app.quit();
  }
}
app.whenReady().then(() => {
  app.setAppUserModelId("app.zhilume.server");
  config.dataDirectory = join(app.getPath("userData"), "data");
  try {
    const saved = JSON.parse(readFileSync(configFile(), "utf8"));
    if (
      Number.isInteger(saved.port) &&
      saved.port >= 1024 &&
      saved.port <= 65535 &&
      typeof saved.dataDirectory === "string" &&
      saved.dataDirectory
    )
      config = saved;
  } catch {}
  const onlyLauncher =
    (fn) =>
    (event, ...args) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Invalid launcher sender");
      return fn(...args);
    };
  ipcMain.handle(
    "server:state",
    onlyLauncher(() => snapshot()),
  );
  ipcMain.handle("server:start", onlyLauncher(start));
  ipcMain.handle("server:stop", onlyLauncher(stop));
  ipcMain.handle("server:open", onlyLauncher(openAdmin));
  ipcMain.handle(
    "server:browser",
    onlyLauncher(async () => {
      await verifyAdmin();
      await shell.openExternal(address() + "/admin/");
    }),
  );
  ipcMain.handle(
    "server:copy",
    onlyLauncher(() => {
      clipboard.writeText(credential());
      return true;
    }),
  );
  ipcMain.handle(
    "server:directory",
    onlyLauncher(async () => {
      if (child) throw new Error("请先停止服务再修改数据目录");
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
        defaultPath: config.dataDirectory,
      });
      return result.canceled ? null : result.filePaths[0];
    }),
  );
  ipcMain.handle(
    "server:configure",
    onlyLauncher((value) => {
      if (child) throw new Error("请先停止服务再修改配置");
      const port = Number(value.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error("端口应在 1024–65535 之间");
      if (
        typeof value.dataDirectory !== "string" ||
        !value.dataDirectory.trim()
      )
        throw new Error("请选择数据目录");
      config = { port, dataDirectory: resolve(value.dataDirectory) };
      mkdirSync(app.getPath("userData"), { recursive: true });
      writeFileSync(configFile(), JSON.stringify(config, null, 2));
      record("配置已保存。更换数据目录不会迁移已有数据。");
      return snapshot();
    }),
  );
  ipcMain.handle("admin:session", async (event) => {
    if (
      !adminWindow ||
      event.sender !== adminWindow.webContents ||
      event.senderFrame !== adminWindow.webContents.mainFrame ||
      !event.senderFrame.url.startsWith(address() + "/admin/")
    )
      throw new Error("Invalid admin sender");
    const response = await fetch(address() + "/api/v1/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: credential() }),
    });
    if (!response.ok) throw new Error("本机管理台登录失败");
    return response.json();
  });
  window = new BrowserWindow({
    width: 880,
    height: 900,
    minWidth: 720,
    minHeight: 700,
    title: "Zhilume Server",
    icon,
    backgroundColor: "#141414",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.loadFile(join(__dirname, "launcher.html"));
  window.on("close", (event) => {
    if (child && !quitting) {
      event.preventDefault();
      window.hide();
      if (!tray.__notified) {
        tray.displayBalloon({
          title: "Zhilume Server 正在后台运行",
          content: "右键托盘图标可以打开管理台或停止并退出。",
        });
        tray.__notified = true;
      }
    }
  });
  tray = new Tray(icon);
  tray.setToolTip("Zhilume Server");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示启动器",
        click: () => {
          window.show();
          window.focus();
        },
      },
      {
        label: "打开管理台",
        click: () =>
          void openAdmin().catch((e) => {
            window.show();
            record(e.message);
          }),
      },
      { type: "separator" },
      { label: "停止并退出", click: () => void quit() },
    ]),
  );
  tray.on("double-click", () => {
    window.show();
    window.focus();
  });
});
app.on("before-quit", (event) => {
  if (child && !quitting) {
    event.preventDefault();
    void quit();
  }
});
app.on("window-all-closed", () => {
  if (!child) app.quit();
});
