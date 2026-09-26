# 上海二 A 5090 实测记录

2026-09-26，在优云智算 **上海二 A（cn-sh2-01）** 完成真实 Worker / ComfyUI 验收。本机仅运行 Server，没有运行本机 ComfyUI 或使用本机 GPU。执行版本为 Server 0.6.0、Worker 0.5.0，协议 2.0；Studio 本轮未修改。

## 环境及修正

- 单张 RTX 5090，32607 MiB 显存；14 vCPU、48 GiB 内存、100 GiB 系统盘。64 GiB 规格预检显示可用，但创建实际返回资源不足，改为同区 48 GiB 成功，没有切换区域。
- 使用官方基础镜像 `compshareImage-1vjzi0b9thpu`。镜像自带 ComfyUI 缺少 `TextEncodeQwenImage21`，升级并固定为官方提交 `79be670e2d9be63e238785af307369d2b9039ed1`。
- Torch 2.10.0+cu130、ComfyUI Python 3.10.15；Worker 独立 Python 3.12.3 环境；FFmpeg 6.1.1。ComfyUI `pip check` 无依赖冲突。
- 六个 Qwen 权重均实际位于只读 `/model/ModelScope/Comfy-Org/`。使用精确软链接，没有下载或复制模型权重。
- 镜像默认 xFormers 在 2.1 文本编码时因 sm_120 / attention mask 支持问题失败。采用 PyTorch attention 后成功，固定启动参数为 `--use-pytorch-cross-attention --disable-xformers --disable-all-custom-nodes`，使用内置节点，不修改 ComfyUI 核心代码。
- 国内 PyPI 镜像缺少一个新模板依赖，通过官方 PyPI 补齐并核对下载 SHA-256；这属于运行依赖，不是模型下载。
- Worker 由 Supervisor 管理，提供经过平台 HTTPS 入口访问的鉴权服务；ComfyUI 只监听 127.0.0.1。未向产品加入云平台、SSH 隧道或组网实现。

## 真实任务结果

耗时从本机提交到确认归档，包含网络、模型加载/切换和输出传输。每项只有一次所列样本，缓存状态不同，**不是性能基准或速度承诺**。

| 操作 | 设置 / 输出 | 结果 | 端到端耗时 |
|---|---|---|---|
| 云端抽音轨 | 2 秒测试视频截取 0.25–1.5 秒，PCM WAV | 通过 | 6.4 秒 |
| Qwen 2512 文生图 | 512×512，30 步，PNG | 通过 | 41.6 秒 |
| Qwen 2512 文生图 | 1024×1024，50 步，PNG | 通过 | 47.8 秒 |
| Qwen 2.1 文生图 | 512×512，25 步，PNG | 通过 | 23.5 秒 |
| Qwen 2.1 指令编辑 | 蓝茶壶改红色，1024×1024，25 步 | 通过 | 14.4 秒 |
| Qwen 2.1 双图参考 | 茶壶与机器人组合，1024×1024，25 步 | 通过 | 14.5 秒 |
| Qwen 2.1 四图参考 | 四个物体组合，1024×1024，25 步 | 通过 | 47.6 秒 |
| Qwen 2.1 透明输出 | 512×512，25 步，RGBA，alpha 范围 0–255 | 通过 | 6.3 秒 |
| Qwen 2.1 较大尺寸 | 1536×1536，25 步，PNG | 通过 | 17.5 秒 |

模型文件与配置对应 Worker `deploy/models.example.json`、`config/comfy.example.json`。编辑和多参考按第一张参考图比例及 1024 参考分辨率生成；不会擅自把参考比例改为用户指定的文生图尺寸。

2 秒采样观测到的显存最高值约 28 GiB（28344 MiB），包含驻留模型缓存，不能据此推导最低显存需求。4 张参考图和 2.1 的 1536 正方形已有样本验证；其他比例、内容、长时负载仍可能使用更多资源。

## 协议与恢复

- 真实 GPU 任务确认提交后请求取消，最终为 `cancelled`；ComfyUI 历史记录含 `execution_interrupted`，运行与待执行队列均为空。
- Server 完全不监听入站端口，主动连接远程 Worker。生成过程中关闭 Server 12 秒，重建同一 Server 后仍归档原 attempt，未重新提交 GPU 任务。
- 未鉴权请求云端 Worker 返回 401。输入和输出按现有协议验证 SHA-256；公开结果报告不含密钥或签名下载 URL。
- 重启 Worker 后身份及 Server 绑定保持，重新连通并通过云端抽音轨。
- 云端 Worker 自动测试 15/15，含实际 FFmpeg 与符号链接；部署 shell 语法检查通过。新增云验收脚本已经在该实例执行。

## 复现

先按 Worker 部署文档准备独立实例及专用 Worker 状态目录，在 Server 仓库构建后运行。首次通过环境变量提供 `ZHILUME_WORKER_ADDRESS` 和 `ZHILUME_WORKER_TOKEN`；脚本创建独立测试 Server，不修改日常 Server 数据。不要指向已经绑定日常 Server 的 Worker。测试状态默认保存在被 Git 忽略的 `artifacts/cloud-acceptance`，可通过 `ZHILUME_ACCEPTANCE_DIR` 改到独立目录；不要并行运行同一目录。

```bash
npm run build
node scripts/accept-cloud.mjs cpu --execute
node scripts/accept-cloud.mjs 2512 --execute
node scripts/accept-cloud.mjs 21 --execute
node scripts/accept-cloud.mjs edit --execute
node scripts/accept-cloud.mjs refs --execute
node scripts/accept-cloud.mjs rgba --execute
node scripts/accept-cloud.mjs refs4 --execute
node scripts/accept-cloud.mjs cancel --execute
node scripts/accept-cloud-reconnect.mjs --execute
```

`edit` 使用前面的 2.1 结果；`refs` 使用 2.1 和 2512 结果；`refs4` 还使用 edit、rgba 的结果。额外模式 `2512-large` 和 `21-large` 分别验证上述较大尺寸。每次 `--execute` 都会实际执行，GPU 模式需要已运行的 GPU Worker；脚本不会创建实例。

原始参数、样本 SHA-256 与采样摘要见 [acceptance.json](../evidence/cloud-2026-09-26/acceptance.json)。样本：[2512](../evidence/cloud-2026-09-26/2512.png)、[2.1 原图](../evidence/cloud-2026-09-26/21.png)、[指令编辑](../evidence/cloud-2026-09-26/edit.png)、[双图参考](../evidence/cloud-2026-09-26/refs.png)、[四图参考](../evidence/cloud-2026-09-26/refs4.png)、[透明输出](../evidence/cloud-2026-09-26/rgba.png)。

## 尚未覆盖

没有把一个实例的结果推广为所有 Worker 的验证状态；公开 profile 仍使用 `validation: unverified`，在线可执行与人工样本验收分别记录。尚未完成华北二 A、新镜像冷启动、GPU OOM/驱动崩溃、长时间网络隔离、并发压力、原生 Studio 全流程。视频/音频生成仍未接入。本轮不制作或发布镜像。

基础版本参考：[Qwen 官方节点](https://github.com/Comfy-Org/ComfyUI/blob/79be670e2d9be63e238785af307369d2b9039ed1/comfy_extras/nodes_qwen.py)。平台端口使用官方 [Pod 端口接口](https://compshare.cn/docs/gpus/instance/updatecompshareinstanceports) 操作，属于部署环境配置，不是产品网络功能。
