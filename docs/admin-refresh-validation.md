# 管理台改版验收（2026-09-29）

- Server 0.12.0：`npm test`，27 项测试中 26 通过、1 项 Linux 部署专项按平台跳过，无失败。新增协议测试包含三协议的目录获取、双模型保存、默认用途、真实 Server 队列执行及素材归档；模型服务端采用本机 HTTP 模拟响应，不代表各供应商真实模型已验收。
- Web：`npm run build`、`node scripts/verify-admin-ui.mjs` 通过。脚本依赖相邻 Studio 开发依赖中的 Playwright 和本机 Edge。使用独立临时数据、测试 Key 和素材，不调用外部模型。验证登录、Server 连通标签、预设选择、多模型配置回填、默认用途、密钥不回显、深浅主题、服务设置、素材目录与文本预览。截图保存在忽略目录 artifacts/admin-refresh。
- 原生 Server 发布 EXE：实际点击“启动并打开管理台”，确认自动弹出并自动登录；窗口标题含 Server / 启动器或管理台 / 织镜；0 Worker 时显示已连接 Server；打开素材目录成功；点击停止服务后子进程退出、管理台关闭。启动器中遗留“仅模拟”文案在验收中发现并修正。
- Studio 0.14.1：TypeScript、Vite 与 Electron 打包通过；此次只改窗口标题与版本/发布说明，不改变画布或媒体逻辑。
- Worker：管理页 TypeScript、Vite 构建通过，浏览器标题统一；未部署到云实例。
- 最新可运行包位于各自 release/win-unpacked，程序包内版本已读取核对。旧 language-* / win-unpacked.tmp 目录移到 Server artifacts/obsolete-builds、Studio .test-data/obsolete-builds，可恢复且不混入 release。
- 未执行云平台实例启动、真实 GPU 推理、付费 API 推理或网络组网。云平台分配地址的可达性仍需在用户选择的运行实例上同时验证 HTTP、WebSocket。
