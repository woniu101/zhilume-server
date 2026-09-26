# 协议开发基线（信封 1.0 / 能力目录 1.1）

当前实现覆盖 GPU 图片执行协议、CPU 媒体处理及显式模拟闭环；GPU 推理尚未验收。初版直接修改契约，不为历史开发版保留兼容分支。能力目录由 Server 发布、Worker 内含带 SHA-256 的快照。

## Worker 接入

1. 管理员 `POST /api/v1/enrollments` 获取单次凭证。
2. Worker `POST /api/v1/workers/register`，JSON 为 `{token,name,platform}`，获得 `{workerId,credential,protocolVersion}`。
3. 用 Worker Bearer 凭证连接 `/api/v1/worker/connect`。
4. 发送 hello，payload 包含 `capabilities: string[]`、`activeAttempts: string[]`、`imageProfiles`。未启用图片执行时 imageProfiles 为空数组。
5. Server welcome 后接收任务，维持 10 秒心跳；90 秒租约由 heartbeat 续期。

信封字段：`protocolVersion: "1.0"`、`messageId`、`type`、`payload`。任务消息还必须有 `jobId`、`attemptId`、`leaseId`；进度有递增整数 `sequence`。消费者必须验证当前契约，不要直接信任对端消息。

## 一次任务

`task.assign` → `task.accepted` → 多次 `task.progress` → 上传输出 → `task.result_ready` → `task.commit_ack`。

- assign.payload 包含 operation、input、leaseSeconds。
- `mock.text.echo.v1` 输入 `{text}`，返回 UTF-8 TXT，最多 12,000 字。
- `mock.media.copy.v1` 输入 `{assetId,asset}`，下载原文件并原样上传，Server 再次比较输入输出类型与 SHA-256。
- `media.video.trim.v1` 输入 `{assetId,asset,start,end}`，输出 MP4 H.264/AAC；`media.audio.extract.v1` 同样输入，输出 PCM WAV。start/end 为秒，要求 0 <= start < end <= 86400；Studio 另按实际时长限制范围。无音轨时抽取任务失败，不伪造静音。
- Worker CPU 执行器运行 FFmpeg 子进程，取消/租约过期终止进程；进度来自输出时间。
- Worker 下载：`GET /api/v1/worker/jobs/{jobId}/inputs/{assetId}`。
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
| Capability | GET /capabilities；GET /image-models（模型目录、在线执行配置及未验收状态） |
| Admin | GET /stats |
| UI events | POST /events/ticket；WS /events?ticket=... |

以上路径统一带 `/api/v1` 前缀。Canvas PUT 使用乐观锁。Job POST 必须带 requestId，重复同负载返回同一任务，同 ID 不同负载返回冲突。


viewport 的 zoom 限制 0.15–2.5。Folder PATCH 校验所属项目与祖先环路；DELETE 只移除组织层级，条目和直接子文件夹原子提升至父级，Asset 不受影响。

## 素材来源

普通素材上传可携带 `X-Asset-Provenance` JSON：`{operation,sourceAssetIds,parameters}`。只接受已知媒体操作，1–16 个已归档来源资产和最多 4096 字符的参数对象。该信息用于追溯，不作为操作已经由服务端验证执行的证明。Worker 输出来源由 Server 根据 Job 输入生成，客户端不能覆盖其任务归属。

本地处理支持 image.crop.v1、image.collage.v1、image.grid.v1，CPU 处理使用上述 media.* 标识。新结果保留不可变原资产；替换节点只改变引用。

## 图片操作与执行配置

能力目录版本 1.2.0。Qwen Image 2512 仅支持 `image.generate.v1`；2.1 另支持 `image.edit.v1` 与 `image.reference.v1`。模型状态仍为 `awaiting_gpu_validation`，这与在线可试运行状态相互独立。

hello.imageProfiles 为公开配置数组：modelId、profileId（64 位 SHA-256）、workflowRevision、operations、maxReferences、formats、minSize=256、maxSize<=2048、sizeStep=32、referenceResolution、defaultSteps、maxSteps=100、validation=unverified。Worker 仅在明确启用并通过只读节点/模型检查后发布。Server 按操作、模型、配置指纹与工作流版本共同调度，不能只按 image.generate 匹配。

图片 Job 输入：

```json
{
  "modelId": "qwen-image-2.1",
  "profileId": "由在线 Worker 返回的 64 位指纹",
  "workflowRevision": "qwen21-v1",
  "prompt": "将参考图转为水彩插画",
  "negativePrompt": "",
  "referenceAssetIds": ["第一张", "第二张"],
  "steps": 25,
  "seed": 42,
  "outputFormat": "png"
}
```

- 文生图参考数组必须为空，另传 width/height；均为配置范围内的 32 倍数。
- 编辑恰好 1 张；多参考 2–maxReferences 张，不接受重复 ID。每张为已归档图片且不超过 64 MB。
- 编辑/参考禁止同时指定 width/height，referenceResolution 由 Server 从配置补齐。输出比例跟随第一张图，Qwen 工作流取整对齐尺寸。
- Server 派发时附 `referenceAssets` 元信息数组，顺序与 referenceAssetIds 一致。Worker 逐文件下载并校验大小/SHA-256；下载接口只允许当前任务输入 ID。
- profile 离线/变更时拒绝新提交和重试；已排队任务不会自动改投其他模型或配置。
- 输出为单张 PNG，Server 从 Job 生成 provenance，包含有序来源、模型、指纹、工作流版本、种子和参数。结果新建 Asset；原文件不改写。
- ComfyUI 采样百分比尚未接入时，progress=null，展示真实阶段，不能伪造百分比。
- 取消只针对本次 ComfyUI prompt UUID。无法确认停止时回报 failed 并撤下 Worker 图片配置，不可显示为已取消。提交响应丢失不自动重发。

真实权重、显存上限、生成质量、RGBA 效果、GPU 故障恢复须另行验收。本地测试服务只证明接口与状态闭环。


## 画布编辑草稿与执行端诊断

媒体节点 data.generationDraft 保存图片表单：operation、modelId、profileId、prompt、negative、sizeMode、refs（有序素材 ID）、format、width、height、steps、seed；可选 request={fingerprint,id,seed} 保存未确认提交的幂等请求。data.textDraft 保存未应用到正文的文本编辑。草稿允许空提示词等未完成状态，Server 校验类型、长度与范围；真正提交任务时仍执行严格输入校验，草稿不代表可执行任务。复制节点应清除 request。沿用画布 revision 乐观锁与本地草稿恢复机制。

GET /workers 增加派生 state（disabled/offline/draining/busy/ready）、reason、heartbeatAgeSeconds 和 activeJobs（id/status/stage）。心跳年龄超过 40 秒或连接断开时派生为 offline；状态不表示 GPU 模型已通过推理验收。注册凭证摘要不对外返回。
