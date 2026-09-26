# 协议开发基线（信封 1.0 / 能力目录 1.1）

当前实现覆盖 CPU 媒体处理及显式模拟闭环。初版直接修改契约，不为历史开发版保留兼容分支。能力目录由 Server 发布、Worker 内含带 SHA-256 的快照。

## Worker 接入

1. 管理员 `POST /api/v1/enrollments` 获取单次凭证。
2. Worker `POST /api/v1/workers/register`，JSON 为 `{token,name,platform}`，获得 `{workerId,credential,protocolVersion}`。
3. 用 Worker Bearer 凭证连接 `/api/v1/worker/connect`。
4. 发送 hello，payload 包含 `capabilities: string[]`、`activeAttempts: string[]`。
5. Server welcome 后接收任务，维持 10 秒心跳；90 秒租约由 heartbeat 续期。

信封字段：`protocolVersion: "1.0"`、`messageId`、`type`、`payload`。任务消息还必须有 `jobId`、`attemptId`、`leaseId`；进度有递增整数 `sequence`。消费者必须验证当前契约，不要直接信任对端消息。

## 一次任务

`task.assign` → `task.accepted` → 多次 `task.progress` → 上传输出 → `task.result_ready` → `task.commit_ack`。

- assign.payload 包含 operation、input、leaseSeconds。
- `mock.text.echo.v1` 输入 `{text}`，返回 UTF-8 TXT，最多 12,000 字。
- `mock.media.copy.v1` 输入 `{assetId,asset}`，下载原文件并原样上传，Server 再次比较输入输出类型与 SHA-256。
- `media.video.trim.v1` 输入 `{assetId,asset,start,end}`，输出 MP4 H.264/AAC；`media.audio.extract.v1` 同样输入，输出 PCM WAV。start/end 为秒，要求 0 <= start < end <= 86400；Studio 另按实际时长限制范围。无音轨时抽取任务失败，不伪造静音。
- Worker CPU 执行器运行 FFmpeg 子进程，取消/租约过期终止进程；进度来自输出时间。
- Worker 下载：`GET /api/v1/worker/jobs/{jobId}/input`。
- Worker 上传：`POST /api/v1/worker/jobs/{jobId}/output?filename=...`，body 为二进制流，Content-Type 为 application/octet-stream。
- 两个文件接口均要求 Worker Bearer、`X-Attempt-Id`、`X-Lease-Id`。
- 上传返回 `{id,size,sha256}`；result_ready.payload 为 `{assetId,sha256}`。
- commit_ack 之前不可清理本地输出；重复 result_ready 可获得重复确认。

## 状态与恢复

任务状态：queued、assigned、running、cancel_requested、succeeded、failed、cancelled、interrupted。

取消发送 task.cancel，Worker 停止后回报 task.cancelled。未确认取消前不宣称已取消。失联过租约后为 interrupted。重试保留 Job ID，创建新 attempt/lease，历史 attempts 可查看。迟到的旧尝试不得写入当前结果。Worker 重启时 hello 不声明无法恢复的旧执行。

## 主要 HTTP 接口

除系统信息、凭证交换、Worker 注册和签名媒体 URL 外，均需对应角色的 Bearer 凭证。

| 资源 | 已实现接口 |
|---|---|
| Session | POST /session |
| Project | GET/POST /projects；PATCH /projects/:id |
| Canvas | GET/PUT /projects/:id/canvas；PUT 含 schemaVersion=1、baseRevision、nodes、edges，可选 viewport={x,y,zoom} |
| Asset | POST /assets/uploads?filename=...；GET /assets、/assets/:id、/assets/:id/content |
| Library | GET/POST /projects/:id/library；PATCH/DELETE /library/:id |
| Folder | POST /projects/:id/folders；PATCH/DELETE /folders/:id |
| Job | GET/POST /jobs；GET /jobs/:id；POST /jobs/:id/cancel、/retry |
| Worker | GET /workers；PATCH /workers/:id（draining/disabled） |
| Capability | GET /capabilities；GET /image-models（规划模型，不可调度） |
| Admin | GET /stats |
| UI events | POST /events/ticket；WS /events?ticket=... |

以上路径统一带 `/api/v1` 前缀。Canvas PUT 使用乐观锁。Job POST 必须带 requestId，重复同负载返回同一任务，同 ID 不同负载返回冲突。


viewport 的 zoom 限制 0.15–2.5。Folder PATCH 校验所属项目与祖先环路；DELETE 只移除组织层级，条目和直接子文件夹原子提升至父级，Asset 不受影响。

## 素材来源

普通素材上传可携带 `X-Asset-Provenance` JSON：`{operation,sourceAssetIds,parameters}`。只接受已知媒体操作，1–16 个已归档来源资产和最多 4096 字符的参数对象。该信息用于追溯，不作为操作已经由服务端验证执行的证明。Worker 输出来源由 Server 根据 Job 输入生成，客户端不能覆盖其任务归属。

本地处理支持 image.crop.v1、image.collage.v1、image.grid.v1，CPU 处理使用上述 media.* 标识。新结果保留不可变原资产；替换节点只改变引用。

## 模型接入边界

Qwen Image 2512 文生图与 Qwen Image 2.1 文生图/指令编辑/多图参考在 `operation-catalog.json` 单独定义。所有模型当前为 awaiting_gpu_validation，不属于 executableCapabilities。预检不发任务、不开 GPU；实际 ComfyUI API 工作流、参考上限、尺寸、资源需求需 GPU 阶段确定并独立验收。
