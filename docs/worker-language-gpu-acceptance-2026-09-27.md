# Worker 语言执行器真实 GPU 验收

2026-09-27，上海二 A，RTX 5090 32 GB。Server 0.11.1、Worker 0.12.1。复用已有验收实例与公共模型，未在 Windows/WSL 安装大型推理依赖或执行模型。

## 模型与环境

- 模型：[Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B)，公共目录中的原始 Safetensors 在云端转换成 BF16 单文件 GGUF，约 18.4 GB。没有重新下载权重；格式转换产生本地部署文件，不能宣称直接链接原目录即可运行 llama.cpp。
- 后端：[llama.cpp b11218](https://github.com/ggml-org/llama.cpp/releases/tag/b11218)，官方 Linux x64 CUDA 12.8 构建，程序报告 commit `33c923db1`。实例实际 Ubuntu GLIBC 2.39；不能将此二进制的可运行性推及所有 Linux 发行版。
- 转换工具的单独虚拟环境只读复用现有 Torch 2.8.0+cu128 / Transformers 4.57.6；Worker 核心不含 Torch。模型转换与依赖准备由操作者显式执行，不是接单时自动安装。
- 程序目录、模型、Worker 版本目录、持久状态分开。通过核心发布工具安装并激活新版本，沿用原身份与管理/任务凭证。

## 实测结果

| 场景 | 结果 |
| --- | --- |
| 中文文本生成 | 成功，TXT 69 字节，内容及归档哈希一致 |
| Qwen 图片提示词优化 | 成功，中文建议 72 字节，未修改提交原稿 |
| H3 官方规则建议 | 成功，343 字节，包含画面、环境音和配乐字段；这只是语言优化，未运行 H3 视频推理 |
| 语言生成中取消，后续任务排队 | 观察到真实 GPU 占用和“生成文本”阶段后取消；约 1000 ms 到 cancelled，排队任务随后成功 |
| 语言 → Qwen Image 2512 → 语言 | PNG 294,000 字节归档成功；停止 ComfyUI 后再次生成文本成功 |
| 资源释放 | 语言任务结束约 2 MiB；图片任务结束、服务仍运行时约 746 MiB，停止服务后约 2 MiB；无资源隔离残留 |
| 升级及正常重启 | Worker 身份、绑定文件、任务凭证、管理凭证哈希保持一致；重启后真实生成再次成功 |
| 无 Server 连接时管理 | 缺模型检查明确失败；管理入口持续可用，修复配置、检查和启用成功 |

完整主流程约 2 分 10 秒。管理采样 106 次，其中任务活跃 58 次，0 失败，P95 333 ms、最大 432 ms。这是经操作者临时 SSH 转发路径的单实例样本；不能据此保证公网转发、所有模型或高并发性能。

Server 主流程没有监听入站端口（`serverListening=false`），由 Server 主动访问 Worker 并取回产物。临时 SSH 转发仅用于运维验收，退出脚本后关闭，不属于产品网络功能。

## 验收发现与修复

第一轮使用模型默认思考行为，短请求耗尽 1024 Token 输出预算，Worker 按输出不完整拒绝归档。失败记录保留，未通过增加成功容忍度掩盖。

修复后 `reasoningMode=off|auto` 加入模型执行规格，创作默认关闭思考，模型生成正常完成；遇到长度上限仍明确失败。思考设置不同的部署不会静默匹配为同一规格。

新 llama.cpp 发布包中的 `llama-server` 只有约 18 KB，主体位于共享库。新增 `runtimeFiles` 与一一对应的 `identity.artifacts.runtime.*` SHA256：检查实际库内容、执行前检查变更，库路径不进入匹配。本次声明并检查 29 个实际运行库文件，避免只验证启动器。

## 复测与发布

- 复用脚本：`scripts/accept-language-gpu.mjs --execute`；可选 `--language-only` 跳过图片切换、`--smoke-only` 仅验证文本及释放。
- 环境变量：`ZHILUME_WORKER_ADDRESS`、`ZHILUME_WORKER_TOKEN`、`ZHILUME_MANAGEMENT_TOKEN`、`ZHILUME_SERVER_DATA`、`ZHILUME_ACCEPTANCE_DIR`、`ZHILUME_EXPECTED_WORKER_VERSION=0.12.1`。使用已绑定该 Worker 的专用验收 Server 数据目录，并先保存语言配置；默认完整流程还要求已有 `comfy-main` 和 Qwen 2512。
- 脚本失败会尝试取消本轮任务并保留失败证据；云实例关闭由操作者另行执行。
- Worker 本地回归 54 项：49 通过、5 项 Linux 专用测试跳过；语言执行器 6 项通过。Server 路由、队列与语言 Worker 聚焦回归 4 项全部通过。核心 wheel、Linux bundle、Worker 管理前端与 Server 构建通过。
- 原始记录保存在工作区 `research/language-gpu-2026-09-27/`；版本化脱敏证据见 [JSON](worker-language-gpu-evidence-2026-09-27.json)。本轮启动的实例已由云平台确认 **Stopped**，部署环境保留。

## 边界

本轮只验收单张 5090、BF16 Qwen3.5-9B、固定 llama.cpp 构建和 Linux 宿主。未覆盖其他量化、视觉输入、其他云平台/自有主机、多个物理 GPU、Worker 硬崩溃回收或新的 Electron 原生交互。没有执行本轮真实 Studio 页面 → GPU 的浏览器验收；既有 Studio 交互测试与本轮 Server → Worker 实测分开记录。

语言执行器的一键安装、完整 GGUF 产物管理及云镜像发布尚未实现。DeepSeek API 验收配置未改动；媒体处理位置、API/GPU/FFmpeg 独立队列和权限边界保持不变。
