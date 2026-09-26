# 协议开发基线（信封 2.0 / 契约快照 2.0.0）

当前实现覆盖 GPU 图片执行协议、CPU 媒体处理及显式模拟闭环；GPU 推理尚未验收。初版直接修改契约，不为历史开发版保留兼容分支。能力目录由 Server 发布、Worker 内含带 SHA-256 的快照。

## Worker 接入

1. Worker 启动受鉴权接入服务，默认 127.0.0.1:4320；本机 --show-token 显示独立接入密钥。无需 Server 地址。
2. 管理员 POST /api/v1/workers/probe 测试 {address,credential}；POST /api/v1/workers 保存，可附 name。GET /workers 不返回密钥。
3. Server 主动请求 Worker /api/v1/system，校验 workerId 和协议 2.0；主动建立 /api/v1/connect WebSocket，Authorization Bearer 与 X-Zhilume-Server-Id 通过请求头传递。
4. Worker 首次鉴权连接绑定 Server 身份；其他 Server 拒绝接入。hello 包含 workerId、capabilities、imageProfiles、activeAttempts；Server welcome 后允许接单。
5. Server 管理持久连接及退避重连；Worker 10 秒心跳，默认 90 秒租约。停用断开连接；排空不接新任务。

## 一次任务

`task.assign` → `task.accepted` → Server 上传输入 → `task.inputs_ready` → `task.progress` → `task.result_ready` → Server 下载/校验/归档 → `task.commit_ack`。

- 信封 protocolVersion=2.0；任务消息包含 jobId、attemptId、leaseId，进度有递增 sequence。
- 输入元信息包含 id、filename、size、sha256，图片参考保持声明顺序；Worker 不访问 Server 的素材 URL。
- Server PUT Worker `/api/v1/attempts/{attemptId}/inputs/{assetId}` 流式上传，鉴权头加 X-Lease-Id。Worker 校验任务归属、有效租约、大小与哈希后原子改名；完整文件重复上传直接确认。
- result_ready.payload 为 `{filename,size,sha256}`；Server GET 同一 Worker `/api/v1/attempts/{attemptId}/output`，流式导入并核对声明和能力契约。结果只归档到当前有效尝试。
- Worker 收到 commit_ack 后清理成功输出；重复 result_ready 在归档后再次得到确认。连接中断期间保留输出；进程重启不自动重复执行，Server 标记中断后允许手动重试。
- 模拟、CPU 与图片生成仍使用原有操作 ID；CPU 输入 {assetId,start,end}，输出 MP4 H.264/AAC 或 WAV PCM。模拟结果必须标记 simulation。
- 原 enrollments、workers/register、worker/connect 和 Worker 回调文件接口全部移除，不兼容协议 1.0。

## 状态与恢复

任务状态：queued、assigned、running、cancel_requested、succeeded、failed、cancelled、interrupted。

取消发送 task.cancel，Worker 停止后回报 task.cancelled。未确认取消前不宣称已取消。失联过租约后为 interrupted。重试保留 Job ID，创建新 attempt/lease，历史 attempts 可查看。迟到的旧尝试不得写入当前结果。Worker 重启时 hello 不声明无法恢复的旧执行。

## 主要 HTTP 接口

除系统信息、凭证交换和签名媒体 URL 外，均需对应角色的 Bearer 凭证。

| 资源 | 已实现接口 |
|---|---|
| Session | POST /session |
| Project | GET/POST /projects；PATCH /projects/:id |
| Canvas | GET/PUT /projects/:id/canvas；PUT 含 schemaVersion=1、baseRevision、nodes、edges，可选 viewport={x,y,zoom} |
| Asset | POST /assets/uploads?filename=...；GET /assets、/assets/:id、/assets/:id/content |
| Library | GET/POST /projects/:id/library；PATCH/DELETE /library/:id |
| Folder | POST /projects/:id/folders；PATCH/DELETE /folders/:id |
| Job | GET/POST /jobs；GET /jobs/:id；POST /jobs/:id/cancel、/retry |
| Worker | GET/POST /workers；POST /workers/probe；PATCH /workers/:id（地址、密钥、名称、draining/disabled） |
| Capability | GET /capabilities；GET /image-models（模型目录、在线执行配置及未验收状态） |
| Admin | GET /stats |
| UI events | POST /events/ticket；WS /events?ticket=... |

以上路径统一带 `/api/v1` 前缀。Canvas PUT 使用乐观锁。Job POST 必须带 requestId，重复同负载返回同一任务，同 ID 不同负载返回冲突。


viewport 的 zoom 限制 0.15–2.5。Folder PATCH 校验所属项目与祖先环路；DELETE 只移除组织层级，条目和直接子文件夹原子提升至父级，Asset 不受影响。

## 素材来源

普通素材上传可携带 `X-Asset-Provenance` JSON：`{operation,sourceAssetIds,parameters}`。只接受已知媒体操作，1–16 个已归档来源资产和最多 4096 字符的参数对象。该信息用于追溯，不作为操作已经由服务端验证执行的证明。Worker 输出来源由 Server 根据 Job 输入生成，客户端不能覆盖其任务归属。

本地处理支持 image.crop.v1、image.collage.v1、image.grid.v1，CPU 处理使用上述 media.* 标识。新结果保留不可变原资产；替换节点只改变引用。

## 图片操作与执行配置

契约快照版本 2.0.0。Qwen Image 2512 仅支持 `image.generate.v1`；2.1 另支持 `image.edit.v1` 与 `image.reference.v1`。模型状态仍为 `awaiting_gpu_validation`，这与在线可试运行状态相互独立。

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
- Server 派发时附 `referenceAssets` 元信息数组，顺序与 referenceAssetIds 一致。Server 逐文件上传，Worker 校验大小/SHA-256；上传接口只允许当前任务输入 ID。
- profile 离线/变更时拒绝新提交和重试；已排队任务不会自动改投其他模型或配置。
- 输出为单张 PNG，Server 从 Job 生成 provenance，包含有序来源、模型、指纹、工作流版本、种子和参数。结果新建 Asset；原文件不改写。
- ComfyUI 采样百分比尚未接入时，progress=null，展示真实阶段，不能伪造百分比。
- 取消只针对本次 ComfyUI prompt UUID。无法确认停止时回报 failed 并撤下 Worker 图片配置，不可显示为已取消。提交响应丢失不自动重发。

真实权重、显存上限、生成质量、RGBA 效果、GPU 故障恢复须另行验收。本地测试服务只证明接口与状态闭环。


## 画布编辑草稿与执行端诊断

媒体节点 data.generationDraft 保存图片表单：operation、modelId、profileId、prompt、negative、sizeMode、refs（有序素材 ID）、format、width、height、steps、seed；可选 request={fingerprint,id,seed} 保存未确认提交的幂等请求。data.textDraft 保存未应用到正文的文本编辑。草稿允许空提示词等未完成状态，Server 校验类型、长度与范围；真正提交任务时仍执行严格输入校验，草稿不代表可执行任务。复制节点应清除 request。沿用画布 revision 乐观锁与本地草稿恢复机制。

GET /workers 增加派生 state（disabled/offline/draining/busy/ready）、reason、heartbeatAgeSeconds 和 activeJobs（id/status/stage）。心跳年龄超过 40 秒或连接断开时派生为 offline；状态不表示 GPU 模型已通过推理验收。连接密钥不对外返回。
