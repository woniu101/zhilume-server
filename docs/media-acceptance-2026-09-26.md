# 媒体处理架构验收

日期：2026-09-26。Studio 0.9.0 / Server 0.7.0 / Worker 0.6.0；Windows x64，隔离测试数据，无在线 Worker，无 GPU 推理。

## 已交付路径

| 操作 | Web | Electron |
|---|---|---|
| 图片裁剪、拼图、宫格切分 | 浏览器 Canvas | Studio Canvas |
| 视频截取、抽音轨 | Server 后台单并发队列 | Electron 主进程管理 FFmpeg |
| AI 生成、指令编辑、多图参考 | GPU Worker | GPU Worker |

两端安装相同的 `@zhilume/media` 0.1.0 包，统一校验、探测、转码参数、进度、取消及错误码。源码唯一维护在 Server 的 `packages/media`，通过 `npm run media:sync -- ../zhilume-studio` 同步版本化 tgz。FFmpeg 5.3.0 npm 包提供本平台二进制，Windows 实际二进制版本为 6.1.1；可执行文件与许可证随包分发。

移除了 Worker 的基础视频执行器、Web FFmpeg WASM 和处理位置选择。Worker 不再发布这两项能力。AI 工作流自身仍可使用云端 FFmpeg。

## 自动验证

- Studio Node 测试 7/7：真实 FFmpeg 的本地原文件直读、远程下载/缓存、哈希变化后的下载回退、窗口隔离、范围校验、取消清理、同步失败保留输出及只重传输出；新增图片原文件读取字节一致性检查。
- Server 全量测试 13 项通过，Linux 专项 1 项在 Windows 跳过。媒体专项验证零 Worker 时导出、并发 1、排队/运行取消、处理期间 API 响应、关闭中断、重启后重试、错误输出以及同步请求幂等。
- 最终 Web 媒体专项 4/4：图片裁剪/保存失败重试/宫格/撤销、拼图顺序与像素、无音轨错误与 Server 截取、Server 抽音轨结果成为可播放音频节点。
- Worker 12 项通过，1 项因 Windows 符号链接权限跳过；确认不发布基础媒体能力，wheel 和源码包构建成功。
- Studio 与 Server 最终 `npm run pack` 均通过。

并行进行两端打包及测试时，额外重跑的 Server 集成测试中有一次模拟 Worker 短租约过期失败。构建结束后单独重跑同一集成文件 3/3 通过，没有放宽租约或断言；不能据此声称高负载调度稳定性已验收。

## Windows 原生 EXE 完整流程

使用发布目录内的 Studio EXE，通过 Windows 原生 UI 操作；Server 使用发布包内的 Electron Node 运行时启动。隔离测试由 Studio 的 `scripts/prepare-native-media-acceptance.mjs` 准备，不使用用户项目或真实素材。Playwright 只准备会话，实际界面操作由原生窗口完成。

1. 远程视频节点 → 视频工具 → 抽音轨 → 下载缓存 → 本地处理 → 同步项目 → 音频新节点，保存成功。产物 WAV，PCM 16-bit，44.1 kHz，单声道，2 秒。
2. 系统文件选择器导入本地竖屏视频 → 插入节点 → 截取 → 同步新节点，保存成功。产物 MP4，H.264，180×320，2 秒。原文件索引登记成功，缓存中只有第 1 步的远程文件，没有本地视频的额外下载缓存。
3. 最终重新打包的 EXE：远程图片 → 图片工具 → 下载原图到缓存（进度可见）→ Canvas 默认全图裁剪 → 预览 → 保存到画布。输出 PNG 180×320，原节点保留，新节点及来源信息入库，画布显示“已保存”。图片原文件直读另有自动测试。
4. 打包后的 Server 在无 Worker 时接受两个 API 媒体任务，分别截取及抽取 0.5–1.5 秒。均返回 `executor=server`、`workerId=null`、`succeeded`，产物均为 1 秒，MP4 为 H.264/AAC，WAV 为 PCM 16-bit。
5. 关闭原生 Studio，结束隔离服务；未留下验收 FFmpeg 进程。

产物使用随包 FFmpeg 解码/探测，图片核对 PNG 尺寸。证据及合成素材输出见 [acceptance.json](../evidence/media-2026-09-26/acceptance.json) 和同目录的 MP4、WAV、PNG。

两端发布包内共享模块 `index.cjs` SHA-256：`55bd35ade8bd52a1c94ec1a618443207183bc21f181d422413d16546d745cd1b`。FFmpeg 及其许可证位于 `resources/app.asar.unpacked/node_modules/ffmpeg-static`；第三方说明位于 `resources/THIRD_PARTY_NOTICES.md`。

## 边界

本次验收限 Windows x64 和 Chromium Web。其他平台新发布包、接近 1 GiB 文件的压力测试、长时间网络中断、所有输入编码及异常关机后的缓存回收尚未实测。原有 Linux 报告属于此前架构，不能代替本版 Linux 验收。该轮不需要启动云端 GPU；AI 推理样本结果见单独的云端报告。
