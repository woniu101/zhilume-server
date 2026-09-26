# ADR 001：首个可运行开发基线

日期：2026-09-25。状态：已用于 0.1.0 基线，不代表所有 PRD 验收完成。

## 三端边界

Studio 为 React + TypeScript + React Flow，富文本使用 Tiptap。Server 使用 Node.js + TypeScript + Fastify，数据库使用 Node 内置 SQLite，资产保存在 Server 文件目录。Worker 现使用 Python + asyncio + FastAPI/Uvicorn 接入服务，httpx 用于内部 ComfyUI；连接方向由 ADR-002 替代初始设计。旧 zhihua-service 不参与实现。

Server Admin 使用 React + TypeScript；Electron Launcher 主进程管理独立的 Server 子进程，启动器的小型本地页面暂用 HTML/CSS/JS。Studio 与 Server 分别打包 Electron，关闭 Studio 不停止 Server。Server 可脱离 Electron 用 Node 运行。

## 存储与并发

SQLite schema 1 采用带类型的记录表保存 JSON，启用 WAL 和 FULL synchronous；项目画布有递增 revision。更新必须提交 baseRevision，冲突返回 409，客户端保留本地草稿。数据库启动有进程锁，禁止同一目录被两个存活 Server 使用。下一步增量迁移必须显式版本化。

上传边读边计量、哈希，暂存文件校验后改名。所有媒体统一 Asset ID；从项目素材库移除只删除引用。Worker 结果暂存与正式归档分离，只有当前 worker/attempt/lease 可提交结果。

## 认证与 UI 更新

首个迭代使用独立会话 Bearer token，浏览器存 sessionStorage，桌面用 safeStorage 加密保存。原始管理员凭证不写入画布或媒体 URL。Server 只存会话哈希和到期时间。HttpOnly 同源会话适配尚未实施，不将这一默认要求标为已完成。

媒体采用限定单资产、1 小时到期的签名 URL；不将其写入画布文档。状态轮询合并时保留仍有效的地址，防止播放器不断重载。Studio/Admin 当前分别每 2.5/3 秒查询权威快照；Server 已有一次性 ticket 的事件 WebSocket，但 UI 事件订阅适配待做。Worker 的 WebSocket 是实际运行路径。

## 执行与结果

只有 `mock.text.echo.v1` 和 `mock.media.copy.v1`，文案始终标识模拟。任务带 requestId、attemptId、leaseId 和递增 sequence。重复 HTTP 提交返回原任务；同 requestId 不同负载拒绝。结果先持久归档再确认，重复结果可重复确认。失联尝试中断，不自动重新执行可能已经有副作用的任务。

画布连线当前保存引用，不隐式批量调度。模拟结果追加为新节点，并记录已接收任务标识；输入节点不被覆盖。真实生成参数、能力适配器和批量工作流不在本轮实现。

## 视觉与交付

中性灰为绝大多数界面底色，雾蓝仅用于主按钮、焦点、选中状态。深色主强调 `#8AAAF0`，浅色主强调 `#365FB5`，普通连线和音频波形为灰色。主题有深色、浅色、系统三种模式；Launcher 暂只提供深浅切换。

当前交付 Windows 目录包而非已签名安装器。打包复用 npm 已安装的 Electron runtime，避免本机 electron-builder 解压阶段发生的目录 rename EPERM。目录包必须完整分发。0.2.0 已加入自定义图标、启动器托盘和目录/端口配置；安装升级、签名与备份向导仍待完善。

协议 schema 和 fixtures 的权威源在 Server/contracts；消费者通过导出脚本获取带哈希 manifest 的副本。工作区根 prd.md 为讨论入口，Server/docs/prd.md 保存相同内容以进入版本控制。


0.2.0 修订：本机 Admin 由 Launcher 创建独立且 sandbox 的 BrowserWindow，验证页面身份后加载同一服务的 /admin/；会话通过验证 sender/frame/origin 的 IPC 获取。会话命名空间与 Studio 分离，外部浏览器入口保留。首次反馈中的旧跳转原因未复现，此修订使入口及服务归属可检查。
