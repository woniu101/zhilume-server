# Zhilume Server

当前 0.3.0 初版，配套 Studio 0.4.0 / Worker 0.2.0。新增 CPU 视频截取、抽音轨、媒体来源记录和 Qwen 模型规划目录。

- `GET /api/v1/capabilities` 只列出执行能力，`ready` 根据在线 Worker 匹配。
- `GET /api/v1/image-models` 单独返回 Qwen 2512 / 2.1 规划信息；待 GPU 验证，不可提交为执行任务。
- 媒体能力和模型规划的源文件为 `contracts/operation-catalog.json`；修改后运行 `npm run contracts:export -- ../zhilume-worker/src/zhilume_worker/contracts`。
- 任务输入含不可变资产 ID、开始/结束秒数，输出归档后保存来源与参数；普通上传也接受经验证的 `X-Asset-Provenance`。
- 不为旧开发版保留兼容层。旧 zhihua 项目仅作能力参考。


织镜的独立服务、Web 管理台与 Windows 启动器。当前为 **0.2.2 开发版**，真实模型尚未接入。

0.2.2：应用图标保留 Z 主体，增加青灰双层服务器角标，与 Studio 的雾蓝笔尖区分；窗口、托盘、EXE 使用统一资源。

0.2.1 修复 Electron Studio 跨域保存：CORS 显式允许 PUT/PATCH/DELETE 等实际使用的方法。更新后需停止并重新启动 Server 服务进程；只更新 Studio 不能修复旧 Server 的预检错误。

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

在管理台“接入执行端”生成一次性 10 分钟凭证，在 Worker 仓库运行生成的命令。Worker 主动连接 Server，无需暴露 Worker 入站端口。

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

Linux 服务使用同一源码和 Node 22.13+：`npm ci && npm run build && npm start`。可由 systemd 等进程管理器运行，数据目录必须可写。远程入口应由反向代理提供 HTTPS，并显式配置来源。**尚未进行 Linux、容器或云平台部署验收**。

本版不是完整首期验收，见 [开发记录](docs/development-status.md) 和 [PRD 快照](docs/prd.md)。
