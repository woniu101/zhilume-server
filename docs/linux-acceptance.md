# Linux 部署与协议验收

日期：2026-09-26。当前版本 Studio 0.8.0 / Server 0.6.0 / Worker 0.5.0，控制协议 2.0。本记录替代之前 Worker 主动回连 Server 的协议 1.0 验收说明。

## 环境与隔离

- 本机 WSL Ubuntu 22.04，Python 3.12.13，Node 22.21.1，uv 0.11.19。
- 当前工作区源码导出到独立 Linux 目录，Worker 使用独立 `.venv`，Server 通过 `npm ci` 安装锁定依赖。
- Node 官方发行包核对官方 SHA-256；FFmpeg 使用 imageio-ffmpeg 0.6.0 提供的 Linux 二进制，仅用于 CPU 测试。
- 未修改用户项目或云实例。没有模型下载、GPU 加载或付费资源调用。

## 结果

| 检查 | 结果 |
|---|---|
| `deploy/install.sh` | 独立 Python 安装成功，默认未启用图片执行 |
| Worker unittest | 15/15，通过真实 CPU 媒体处理、符号链接、鉴权和输入完整性检查，无跳过 |
| Server TypeScript / Admin 构建 | 通过 |
| Server 全量集成测试 | 13/13，无跳过 |
| 部署入口专项（包含于上项） | 直接执行 run.sh；接入、文本输出、0600 身份文件、重启复用同一 Worker |
| 无 Server 入站端口专项（包含于上项） | Server 不调用 listen，仍能连接真实 Worker、执行任务、下载并归档结果 |
| ComfyUI 协议 | 模拟服务通过，不代表真实模型推理 |

与 Windows 打包和浏览器测试同时运行时，使用 2.5 秒测试租约的集成用例曾超时；在打包结束后，专项 3/3 和全量 13/13 通过。测试断言和租约未放宽，只补充了失败时的状态输出；此结果不证明高负载或长期运行稳定性。

重复入口：`bash scripts/accept-linux.sh`，要求三端仓库同级、Node 22.13+、uv、FFmpeg。脚本只启动临时本地测试服务；设置 `ZHILUME_FFMPEG` 可指定已有 FFmpeg。

## 下一阶段边界

需要上海二 A 或华北二 A 的可用实例，以及从 Server 所在机器能访问的 Worker 地址。Server 无需公网入站；网络可达性由用户负责。先验证远程接入、素材传输、CPU 任务与重连，再进入 5090 模型推理。启动 GPU 前告知用户。

尚未证明：云端 Linux 镜像冷启动、公共模型文件真实可读、长期网络故障恢复、Qwen 2512/2.1 生成质量/耗时/显存、OOM 与驱动故障。本机 Linux 和模拟 ComfyUI 的结果不能替代这些检查。
