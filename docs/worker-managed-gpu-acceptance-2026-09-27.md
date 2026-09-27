# Worker 0.10 托管模式真实 GPU 验收

2026-09-27，上海二 A，RTX 5090 32 GB。Worker 0.10.0 / Server 0.10.0，协议 3.0。本轮复用已有 ComfyUI、IndexTTS Python 环境和公共模型文件，没有下载模型或重装 GPU 推理依赖。

## 部署与执行

- 从 Linux 发布包安装独立核心版本目录，激活 `current` 链接，沿用既有 state。图片/视频文件校验所需 Pillow 单独显式安装；核心环境不安装 Torch。
- 停止原 Supervisor 管理的独立 ComfyUI 并关闭其自动启动。Qwen 与 H3 都配置 `runtimeId: comfy-main`，由 Worker 创建同一个本机 ComfyUI 进程；IndexTTS 继续按任务启动独立 Python 进程。
- 托管程序：ComfyUI `79be670e2d9be63e238785af307369d2b9039ed1`；IndexTTS `ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c`。核心 Python 3.12.3；GPU 驱动 610.57.04。
- 受测 wheel SHA-256：`e98dc8ad79b834fd9ea360ca618b3d9e9fce5636f9fecb6773cba0580bcbaae4`。这次没有修改产品运行代码或变更模型规格。

## 结果

| 场景 | 实测结果 |
|---|---|
| 显式启动托管 ComfyUI，再启用三种执行器 | 全部成功；服务启动不执行生成 |
| Qwen Image 2512：512×512、5 步 | PNG 315,283 字节，归档内容 SHA-256 与资产记录一致；任务结束显存 780 MiB |
| 切换 IndexTTS：2 秒参考音频、中文合成 | WAV 147,200 字节，归档哈希一致；任务结束显存 780 MiB |
| 切换 H3 FL2VA：文生视频、512×288、124 帧、20 步、含音频 | MP4 147,001 字节，视频/音轨校验及归档哈希通过；任务结束显存 828 MiB |
| H3 再次执行时，调用共享服务“取消任务后停止” | 约 7.2 秒完成；任务为 cancelled，图片/视频执行器均停用，服务 stopped，显存 2 MiB，无 GPU 隔离残留 |
| 重启 ComfyUI 后重新启用 Qwen 并生成 | PNG 303,061 字节，归档哈希一致，显存回到 780 MiB；之后空闲等待停止成功 |
| ComfyUI 运行时正常重启 Worker | 原受管进程消失，显存 2 MiB，身份/任务凭证/管理凭证/绑定文件哈希不变；重启后托管服务保持 stopped |
| 无 Server 连接时显式恢复服务与执行器 | 管理入口可用，启动服务、启用图片执行器、再次停止成功 |

主生成测试共约 4 分 12 秒；运行中的管理接口采样 50 次，经云端访问路径的响应 P95 614 ms、最大 788 ms，整个测试没有管理探测请求失败。此数据是单实例样本，不是压力测试或性能保证。

Server 测试程序使用真实调度与传输模块，但没有监听入站端口（`serverListening: false`）；所有连接由 Server 发往 Worker，结果经同一连接路径归档。没有要求 Server 公网地址。

Qwen 与语音的 profileId 与先前外部服务模式一致，改为托管环境没有改变其模型执行规格；本机安装目录、runtimeId 和 ComfyUI 地址不参与等价匹配。

## 证据与复测

- 可复用真实 GPU 脚本：`scripts/accept-managed-gpu.mjs --execute`。只通过环境变量接收 Worker 地址、任务/管理凭证、独立验收 Server 数据目录和参考音频；不要把凭证写入仓库。
- 环境变量：`ZHILUME_WORKER_ADDRESS`、`ZHILUME_WORKER_TOKEN`、`ZHILUME_MANAGEMENT_TOKEN`、`ZHILUME_ACCEPTANCE_DIR`、`ZHILUME_SERVER_DATA`、`ZHILUME_AUDIO_FILE`。
- 先准备并保存 `comfy-main` 运行环境以及 image/video/speech 执行器配置；使用专用验收 Server 数据目录，已绑定 Worker 时必须使用对应 Server 身份。脚本会启动真实 GPU 生成，并在正常结束时停用共享服务。
- 脚本失败会尝试取消本轮任务并写出失败记录，但不会关闭云实例。实例启停由操作者负责，不能依赖验收脚本消除云费用。
- 原始结果、归档素材及重启检查保存在工作区 `research/managed-gpu-2026-09-27/`；不随镜像或产品发布。摘要见 [版本化 JSON 证据](worker-managed-gpu-evidence-2026-09-27.json)。

## 边界

本轮通过的是上海二 A 单卡、复用已有环境下的托管生命周期验收。H3 本轮只重测 FL2VA 文生视频与取消；之前的首尾帧和 Ref2VA 样本不能视作本轮重测。没有执行多物理 GPU 并行、运行中等待自然结束再停服、硬崩溃回收、全新 CUDA 推理依赖安装、容器 GPU、其他云平台、自有 GPU 或华北二 A 验收。

本轮启动的实例在验收后执行关机，并以云平台状态确认。通用语言模型执行器仍未接入；下一步应先完成标准环境安装的可重复验收。
