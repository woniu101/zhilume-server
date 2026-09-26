# Zhilume Server

独立服务、Web 管理台与 Windows 启动器。当前 0.6.0 初版，配套 Studio 0.8.0 / Worker 0.5.0。支持图片任务调度、CPU 媒体处理和模拟能力。上海二 A 5090 的真实 Qwen 2512 / 2.1 图片执行与 Server 主动连接链路已完成样本验收，见 [云端报告](docs/cloud-acceptance-2026-09-26.md)。

- `/api/v1/image-models` 返回 Qwen 2512 / 2.1 目录及在线执行配置；未显式启用图片 Worker 时不能提交 GPU 任务。
- 调度按模型、配置指纹、工作流版本和操作匹配，保留多图顺序与结果 provenance。
- 契约源在 `contracts/operation-catalog.json`；修改后同步两端：`npm run contracts:export -- ../zhilume-worker/src/zhilume_worker/contracts ../zhilume-studio/src/contracts`。
- 不为旧开发版保留兼容层；三端需配套升级。旧 zhihua 项目仅作能力参考。
- API、执行配置与证据边界见 [协议](docs/protocol.md) 和 [开发记录](docs/development-status.md)。

新增画布生成草稿校验；管理台展示执行端忙碌/排空/心跳诊断、当前任务，以及直接可见的错误信息。系统接口与管理台版本取自 package.json。

## 本地开发

需要 Node.js 22.13+（当前验证 22.21.1）和 npm。Python 不是运行 Server 的依赖。

```powershell
npm ci
npm run build
npm start
```

默认监听 `http://127.0.0.1:4310`，管理台在 `/admin/`。首次启动自动创建 `.data/admin-token`，将其中的访问凭证粘贴到管理台或 Studio。不要提交 `.data` 或凭证。

后端热更新：`npm run dev`。管理台热更新：另一个终端执行 `npm run dev:admin`，打开 `http://127.0.0.1:5174/admin/`。

| 环境变量 | 默认值 / 用途 |
|---|---|
| `ZHILUME_HOST` | `127.0.0.1` |
| `ZHILUME_PORT` | `4310` |
| `ZHILUME_DATA` | 当前目录下 `.data` |
| `ZHILUME_TOKEN` | 留空自动生成管理员凭证 |
| `ZHILUME_ORIGINS` | 本地 Studio/Admin 开发地址与两个 Electron app 来源；覆盖时用逗号分隔完整来源 |
| `ZHILUME_UPLOAD_LIMIT` | 单文件 1 GiB；文本另限 12,000 字 |

Server 数据目录包含 `zhilume.sqlite`、WAL 文件、`assets/`、管理员凭证和进程锁。**停止服务后复制整个数据目录**进行备份。当前数据库版本为 1；尚未提供跨版本迁移工具或在线一致性备份。

## Windows 可执行目录包

```powershell
npm run pack
```

输出 `release/win-unpacked/Zhilume Server.exe`。运行时必须保留同目录的 DLL、resources 等文件；分发时复制整个 `win-unpacked` 文件夹，不要只取 EXE。

启动器内置 Electron 的 Node 运行环境，不调用全局 `node.exe`。点击“启动 Server”，再“打开管理台”“复制访问凭证”。数据放在 `%APPDATA%/zhilume-server/data`，与开发模式 `.data` 相互独立。默认端口 4310，可在“服务配置”中修改端口与数据目录（先停止服务）。更换目录不自动迁移文件。服务运行时关闭启动器收起到托盘，右键托盘可“停止并退出”；不停止其他程序启动的 Server。

“打开管理台”打开独立的 Server Admin 窗口并自动连接本机服务；“服务配置”还提供外部浏览器入口。两者均访问当前端口的 `/admin/`。Admin 与 Studio 的登录存储相互独立。

`ZHILUME_USER_DATA` 可指定 Electron 启动器配置目录，默认保持原来的 userData；仅用于隔离测试或显式便携部署，不会迁移旧数据。图标源位于 `assets/`，`node scripts/generate-icons.mjs` 可重建两端 ICO/PNG。

`npm run desktop` 使用安装后的 Electron 直接运行开发构建。如果安装依赖时关闭了生命周期脚本，先执行 `node node_modules/electron/install.js`。打包使用这个已安装的 Electron 目录，避免重复下载解压。

## Worker 与协议

在管理台“接入执行端”填写 Worker 地址和接入密钥，可先测试连接。Server 主动连接 Worker，并上传输入、下载结果；Server 无需公网地址。连接地址必须从 Server 所在机器可达。网络配置由用户自行解决，本项目不内置 SSH 隧道、组网、中继或外部工具入口。

协议源在 `contracts/`，跨仓库快照通过脚本生成：

```powershell
node scripts/export-contracts.mjs ../zhilume-worker/src/zhilume_worker/contracts ../zhilume-studio/src/contracts
```

快照包含版本、SHA-256、有效和无效样例。不要手改消费者快照。HTTP 与 Worker 基线见 [协议说明](docs/protocol.md)，具体架构取舍见 [ADR](docs/adr-001-foundation.md)。

## 验证

```powershell
npm test
```

集成测试包含真实 Python Worker 子进程，默认要求相邻 `zhilume-worker` 已执行 `uv sync`。`ZHILUME_TEST_PYTHON` 可指定其他已安装 Worker 包的 Python。测试使用临时数据库和随机端口，不调用 GPU 或付费服务。

Linux 服务使用同一源码和 Node 22.13+：`npm ci && npm run build && npm start`。可由 systemd 等进程管理器运行，数据目录必须可写。远程入口应由反向代理提供 HTTPS，并显式配置来源。已在本机 WSL Ubuntu 22.04 完成 Linux 构建和 Server—Worker 集成验收；容器、公网与云平台部署尚未验收。

本版不是完整首期验收，见 [开发记录](docs/development-status.md) 和 [PRD 快照](docs/prd.md)。

Linux 可重复验收（同级准备三端仓库，Node 22.13+、uv 和 FFmpeg 可用）：

```bash
bash scripts/accept-linux.sh
```

脚本使用独立测试数据、随机本地端口和模拟 ComfyUI，不连接用户服务或加载模型。包含 Worker Python 3.12 安装、完整测试、Server 构建、任务回传、取消/重启重试，以及部署启动脚本的首次注册和身份复用。结果与边界见 [Linux 验收记录](docs/linux-acceptance.md)。
