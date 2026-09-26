# ADR-002：Server 主动访问 Worker

日期：2026-09-26。替代 ADR-001 的 Worker 主动回连设计；初版直接重构，不保留协议 1.0 兼容路径。

Server 常驻用户电脑，不能要求公网入站地址。Worker 地址由用户提供，Server 主动建立 HTTP/WebSocket 连接；业务调度角色与网络发起方向分离。网络可达性由用户解决，SSH 隧道、组网、中继及配套工具入口均不在项目范围。

Worker 使用 FastAPI/Uvicorn 提供接入、上传和输出服务，asyncio 管理执行与租约，ComfyUI 仍为内部引擎。默认 127.0.0.1:4320，公网接入应由用户已有 HTTPS/WSS 入口保护。控制消息协议升至 2.0。

Server 通过地址和密钥校验 Worker 身份，保存稳定 Server UUID 与连接密钥到私有文件 worker-connections.json。API 不返回密钥。Worker 状态目录生成 workerId/密钥，并在首次鉴权连接绑定一个 Server UUID；持久绑定避免两个 Server 同时调度。用户需保留双方数据目录；不从初版旧格式自动迁移。

Server 上传声明的任务输入，Worker 校验大小/SHA-256 后原子落盘；任务控制仍为 assign/accepted/progress/cancel/lease。结果就绪后 Server 主动下载，在同一有效 attempt/lease 下校验并归档，最后确认清理。大媒体不通过控制 WebSocket。

传输与接入集中在 worker-transport.ts，任务状态仍由 Server 统一处理。Worker 执行器 worker.py 与接入 gateway.py 分离。地址修改先核对原 workerId；绑定其他 Server 的 Worker 显式拒绝。断线不重复执行生成，完成文件可重复传输与确认；本轮不实现分块断点续传。

关键验收要求：Server 完全不监听入站端口仍能完成 Worker 任务；错误凭据拒绝、凭据不回显、不同 Server 绑定隔离、Server/Worker 重启身份恢复、取消与过期尝试隔离、CPU 与模拟 ComfyUI 回传。真实云入口和 GPU 推理另行验收。
