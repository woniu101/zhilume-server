# Linux 部署与协议验收

日期：2026-09-26。代码基线：Studio d5ea216（契约快照）、Server a266a7d、Worker c851182；本轮另加 Linux 验收脚本、部署启动专项和测试目录清理修正。产品版本仍为 0.7.0 / 0.5.0 / 0.4.0。

## 环境与隔离

- 本机 WSL Ubuntu 22.04，Python 3.12.13，Node 22.21.1，uv 0.11.19。
- 独立 Linux 工作目录 `/root/.cache/zhilume-linux-qa/`；源码由三端 Git 快照导出，Worker 使用独立 `.venv`。
- Node 官方发行包核对官方 SHA-256；FFmpeg 使用 imageio-ffmpeg 0.6.0 提供的 Linux 二进制，仅用于 CPU 测试。
- 未修改 Windows 默认 Server 数据、用户项目或云实例。没有模型下载、GPU 加载或付费资源调用。

## 结果

| 检查 | 结果 |
|---|---|
| `deploy/install.sh` | 独立 Python 安装成功，默认未启用图片执行 |
| Worker unittest | 14/14，通过真实 CPU 媒体处理和符号链接，无跳过 |
| Server TypeScript / Admin 构建 | 通过 |
| Server 原有集成测试 | 11/11，覆盖模拟四类媒体、真实 CPU 输出、取消、重启重试、调度隔离 |
| 新增部署入口专项 | 1/1，直接执行 run.sh；注册、文本回传、0600 身份文件、重启复用同一 Worker |
| ComfyUI 协议 | 模拟服务通过，不是真实模型推理 |
| 优云智算实例查询 | 当前查询返回 0 个实例，未执行创建或启动 |

原有集成测试先全量运行；新增部署专项随后独立通过。完整重复入口：`bash scripts/accept-linux.sh`，要求三端仓库同级、Node 22.13+、uv、FFmpeg。该脚本只启动临时本地测试服务；设置 `ZHILUME_FFMPEG` 可以指定已有 FFmpeg。

## 下一阶段边界

需要上海二 A 或华北二 A 的可用实例，以及云端能访问的 Server HTTPS/WSS 入口。先验证远程注册、素材传输、CPU 任务与重连，再进入 5090 模型推理。启动 GPU 前告知用户。

尚未证明：云端 Linux 镜像冷启动、公共模型文件真实可读、长时间公网故障恢复、Qwen 2512/2.1 生成质量/耗时/显存、OOM 与驱动故障。这里的本机 Linux 和模拟 ComfyUI 结果不能替代这些检查。
