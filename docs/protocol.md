# 协议开发基线（信封 3.0 / 契约快照 3.0.0）

当前实现覆盖 GPU 图片执行协议、CPU 媒体处理及显式模拟闭环；上海二 A GPU 样本验收见云端报告。初版直接修改契约，不为历史开发版保留兼容分支。能力目录由 Server 发布、Worker 内含带 SHA-256 的快照。

当前完整的规格、依赖、API 队列和界面规范见 [模型与调度基线](model-and-scheduling.md)。GPU 旧样本不替代本次资源释放机制的真实验收。新增 `/models`、`/job-groups`、`/language/providers`、`/language/models`；字段见该基线。

## Worker 接入

1. Worker 启动受鉴权接入服务，默认 127.0.0.1:4320；本机 --show-token 显示独立接入密钥。无需 Server 地址。
2. 管理员 POST /api/v1/workers/probe 测试 {address,credential}；POST /api/v1/workers 保存，可附 name。GET /workers 不返回密钥。
3. Server 主动请求 Worker /api/v1/system，校验 workerId 和协议 3.0；主动建立 /api/v1/connect WebSocket，Authorization Bearer 与 X-Zhilume-Server-Id 通过请求头传递。
4. Worker 首次鉴权连接绑定 Server 身份；其他 Server 拒绝接入。hello 包含 workerId、capabilities、executionSpecs、deployment、activeAttempts；Server welcome 后允许接单。
5. Server 管理持久连接及退避重连；Worker 10 秒心跳，默认 90 秒租约。停用断开连接；排空不接新任务。

## 一次任务

`task.assign` → `task.accepted` → Server 上传输入 → `task.inputs_ready` → `task.progress` → `task.result_ready` → Server 下载/校验/归档 → `task.commit_ack`。

- 信封 protocolVersion=3.0；任务消息包含 jobId、attemptId、leaseId，进度有递增 sequence。
- 输入元信息包含 id、filename、size、sha256，图片参考保持声明顺序；Worker 不访问 Server 的素材 URL。
- Server PUT Worker `/api/v1/attempts/{attemptId}/inputs/{assetId}` 流式上传，鉴权头加 X-Lease-Id。Worker 校验任务归属、有效租约、大小与哈希后原子改名；完整文件重复上传直接确认。
- result_ready.payload 为 `{filename,size,sha256}`；Server GET 同一 Worker `/api/v1/attempts/{attemptId}/output`，流式导入并核对声明和能力契约。结果只归档到当前有效尝试。
- Worker 收到 commit_ack 后清理成功输出；重复 result_ready 在归档后再次得到确认。连接中断期间保留输出；进程重启不自动重复执行，Server 标记中断后允许手动重试。
- Worker 只执行模拟和 GPU 生成，不发布或接收 media.video.trim.v1 / media.audio.extract.v1；模拟结果标记 simulation。
- 原 enrollments、workers/register、worker/connect 和 Worker 回调文件接口全部移除，不兼容协议 1.0。

## 状态与恢复

任务状态：queued、waiting_upstream、assigned、running、cancel_requested、succeeded、failed、blocked、cancelled、interrupted。

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

传输协议 3.0.0、操作目录 1.4.0。Qwen Image 2512 仅支持 `image.generate.v1`；2.1 另支持 `image.edit.v1` 与 `image.reference.v1`。模型状态仍为 `awaiting_gpu_validation`，这与在线可试运行状态相互独立。

hello.executionSpecs 中 kind=image 的 spec 为公开执行规格（含 identity.revision/quantization/artifacts）：modelId、profileId（64 位 SHA-256）、workflowRevision、operations、maxReferences、formats、minSize=256、maxSize<=2048、sizeStep=32、referenceResolution、defaultSteps、maxSteps=100、validation=unverified。Worker 仅在明确启用并通过只读节点/模型检查后发布。Server 按操作、模型、配置指纹与工作流版本共同调度，不能只按 image.generate 匹配。

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
- 已登记 profile 离线时允许提交和重试并等待；未知规格拒绝提交。已排队任务不会自动改投其他模型或配置。
- 输出为单张 PNG，Server 从 Job 生成 provenance，包含有序来源、模型、指纹、工作流版本、种子和参数。结果新建 Asset；原文件不改写。
- ComfyUI 采样百分比尚未接入时，progress=null，展示真实阶段，不能伪造百分比。
- 取消只针对本次 ComfyUI prompt UUID。无法确认停止时回报 failed 并撤下 Worker 图片配置，不可显示为已取消。提交响应丢失不自动重发。

真实权重、显存上限、生成质量、RGBA 效果、GPU 故障恢复须另行验收。本地测试服务只证明接口与状态闭环。


## 画布编辑草稿与执行端诊断

媒体节点 data.generationDraft 保存图片表单：operation、modelId、profileId、prompt、negative、sizeMode、refs（有序素材 ID）、format、width、height、steps、seed；可选 request={fingerprint,id,seed} 保存未确认提交的幂等请求。data.textDraft 保存未应用到正文的文本编辑。草稿允许空提示词等未完成状态，Server 校验类型、长度与范围；真正提交任务时仍执行严格输入校验，草稿不代表可执行任务。复制节点应清除 request。沿用画布 revision 乐观锁与本地草稿恢复机制。

GET /workers 增加派生 state（disabled/offline/draining/busy/ready）、reason、heartbeatAgeSeconds 和 activeJobs（id/status/stage）。心跳年龄超过 40 秒或连接断开时派生为 offline；状态不表示 GPU 模型已通过推理验收。连接密钥不对外返回。

## 普通媒体处理（Studio 0.9 / Server 0.7 / Worker 0.6）

Web POST `/jobs` 参数 `{requestId,projectId,nodeId?,sourceRevision?,operation,input:{assetId,start,end}}`，operation 为 media.video.trim.v1 或 media.audio.extract.v1。返回 `executor=server`、`workerId=null`；GPU/模拟任务为 executor=worker。`/capabilities` 的媒体 ready 只表示 Server 内置 FFmpeg 可用。队列固定单并发，无 Worker lease 或 assigned 阶段。

状态 queued/running/cancel_requested/succeeded/failed/cancelled/interrupted。进度 null 表示校验，0..1 表示编码；归档完成才成功。errorCode 为 invalid_range/no_audio/invalid_media/source_missing/input_limit/output_limit/ffmpeg_unavailable/processing_failed/disk_full/io_error/server_stopped/server_restarted；error 为展示文案。参数错误 HTTP 400，探测错误异步 failed。取消等待进程退出；重试复用 Job ID、新建 attemptId。服务重启不自动重复活动转码，排队任务继续。

Electron IPC：media.create(assetId,operation,{start,end})、run(id)、cancel(id)、retrySync(id)、dispose(id)。窗口隔离所属任务，不接受任意命令、路径或下载 URL。onProgress 事件 `{id,phase,progress:number|null}`；phase 为 validating/downloading/processing/syncing/succeeded/failed/sync_failed/cancelled。run 返回 `{ok:true,asset,sourceKind:local|cache|download}` 或 `{ok:false,error:{code,message},canRetrySync}`。

导入真实 File 后 preload 通过 webUtils 取得路径，按 Server+assetId 登记；读取前比对大小/SHA-256。本地不存在或已变更时从鉴权素材接口流式下载，校验完整性后入缓存并显示字节进度，拒绝重定向。输出 POST `/assets/uploads?filename=...` 带 X-Asset-Provenance 和 X-Media-Sync-Id（任务 UUID）；重复完成的同步返回原 Asset，同步冲突返回 409 sync_busy。同步失败重试不再编码。桌面任务不占 Server 转码队列。

共享源码仅在 packages/media；`npm run media:sync -- ../zhilume-studio` 生成相同 tgz，分别 npm install 刷新锁文件。后续改动递增包版本。两端完整解包 ffmpeg-static 目录与许可证，Web dist 无 WASM。初版 Windows x64 发布，其他平台依赖按目标平台安装构建，不混用 Windows 二进制。

Electron 图片工具使用 createSource(assetId) / readImage(id) 读取上限 64 MiB 的原图字节；复用相同本地路径校验、远程缓存、下载进度与取消机制。图像像素处理留在 renderer Canvas，不调用 FFmpeg。读取会话由 dispose(id) 释放。


## 创作面板能力约束（目录 1.4.0）

GET /image-models 的每个模型返回 referenceLimits.maximum（2512 为 0、2.1 为 10），表示模型能力边界；profiles[].maxReferences 表示当前运行配置边界，Server 与 Worker 拒绝超过模型上限的配置。客户端新增引用取两者最小值，离线最多准备 10 张，提交仍须匹配在线配置。

草稿与可执行请求分开校验：上游画布可能超过模型引用限制，generationDraft.refs 允许最多 1000 个唯一 ID（与画布节点数上限一致），保留超限引用供移除；UI 明确阻止超限任务，不能因为此草稿导致整个项目无法保存。普通添加入口不允许超出当前能力数量。任务的操作、输入顺序、尺寸/透明通道校验和幂等请求身份不变；本轮不新增任务状态。


## 语音生成（目录 1.5.0，wire protocol 3.0）

GET `/speech-models` 返回模型边界和在线 profiles。hello.speechProfiles 包含 modelId、64 位 profileId、workflowRevision、upstreamRevision、maxTextCharacters、languages、emotionModes、validation=unverified。指纹包含部署路径/配置和工作流、上游提交版本，不是权重内容哈希。仅启用并通过文件预检后声明 audio.speech.v1；Server 按完全相同的模型/配置/工作流调度。

POST `/jobs` operation=audio.speech.v1，input 为 `{modelId,profileId,workflowRevision,text,language,speed,speaker:{assetId,start,end},emotionMode,emotionAlpha,emotionReference:{assetId,start,end},emotionText,emotionVector:[8个0..1数值]}`。speaker 必填，emotionReference 仅 reference 模式必填；text 模式需描述，vector 模式需向量。Server 将未启用模式的字段归一化，补齐有序去重 referenceAssetIds 与 outputFormat=wav；同一素材可在两个角色使用不同片段。派发附 referenceAssets，沿用现有受鉴权输入上传，不要求 Server 公网可访问。

data.speechDraft 保存未完成语音表单与可选 request={id,fingerprint}；允许空音频 ID、空文本、不完整片段，长文本草稿上限 100000 字，实际提交上限来自 profile 且最多 1000。界面保留超限输入供调整，禁止静默截断。复制节点清除 request；失败重提相同参数复用请求 ID。Server 重试重新校验在线配置和资产。

任务状态沿用 queued/assigned/running/cancel_requested/succeeded/failed/cancelled/interrupted，executor=worker。进度阶段为准备音色与情绪参考、加载 IndexTTS 并合成语音、校验语音结果，progress=null；结果经校验与归档才成功。Worker 取消/超时先结束所持有子进程再回报；推理失败为 failed，详细原因保留在本地 attempts/<attemptId>/speech.log。来源素材和规范化参数归档至 provenance。普通视频截取/抽音轨仍走 Studio/Server CPU 模块。


## 视频生成（目录 1.6.0，wire protocol 3.0）

GET `/video-models` 返回 FL2VA、Ref2VA 模型目录及在线 profiles。hello.videoProfiles 为 `{modelId,profileId,workflowRevision,modes,sizes:[[w,h]],frames:[124,...],fps:24,referenceLimits:{image,video,audio},defaultSteps,maxSteps:50,validation:unverified}`。只有显式启用且加载器模型/必需节点检查通过才声明 video.generate.v1；该检查不证明推理成功。

POST `/jobs` operation=video.generate.v1，input 为 `{modelId,profileId,workflowRevision,mode,prompt,width,height,frames,steps,seed,includeAudio,references:[{role,assetId,start?,frames?}]}`。mode=text/first/last/first-last/reference；前四种仅接受相应首尾帧图片角色，reference 接受 image/video/audio。时序参考 start 为起始秒数，frames 为 24 FPS 下指定片段长度；至少 56 帧并满足 17k+5，且不超过输出长度。Server 规范化角色字段、补齐 fps=24、outputFormat=mp4 和有序去重 referenceAssetIds；派发附 referenceAssets，使用现有输入文件传输接口。

输出尺寸来自 profile，帧数 124–345、17k+5；参考数量不超过 profile 与总数 12，视频/音频各累计不超过 15 秒。图片上限 64 MiB，其余 256 MiB；不允许 staged 素材。草稿 data.videoDraft 保留首尾帧 ID、参考列表、参数、模式及可选 request={id,fingerprint}，允许空内容、离线 profile、最多 1000 个待调整引用；真正提交严格限制 12。复制节点清除 request。

任务状态复用 queued/assigned/running/cancel_requested/succeeded/failed/cancelled/interrupted，executor=worker。阶段为准备 H3 参考片段、传输参考素材到 ComfyUI、模型执行中、校验视频与音轨，progress=null。取消等待 FFmpeg 退出或 ComfyUI 对应 prompt 停止；无法确认时 failed 并撤下同端点图片/视频能力。输出必须为 H.264 MP4、准确尺寸/帧数/24 FPS，includeAudio=true 时含 32kHz 立体声；归档前校验文件与 SHA-256，成功才回 commit_ack。provenance 保留去重 sourceAssetIds 与完整规范化参数。


## Worker 本机管理 API

FastAPI 同端口提供 `/management` 静态页面及 `/management/api/*`。所有管理 API 单独校验管理 Bearer，任务接入凭证无权访问。GET overview/access/diagnostics/operations；PUT executors/:kind/config；POST executors/:kind/check|enable|disable（停用 policy=wait|cancel）；POST access（configure/unbind/rotate）；POST install（先计划，execute=true 才安装）。长操作返回 operationId，通过 operations 查询。任务 API 仍要求调度凭证及绑定/lease，管理凭证不能替代任务凭证。具体部署及共用 CLI 见 Worker deploy/management.md。

## 语言模型规格

执行规格种类新增 `language`，与图片/语音/视频共用 GPU 调度和任务文件传输；互联网模型仍走独立 API 队列。输入冻结规则与输出 TXT 校验见 [语言执行协议](language-execution.md)。


## 节点结果协议 v1（Server 0.13 / Studio 0.15）

`POST /jobs` 与 `/job-groups` 中的 nodeId 是输出目标节点，必须已保存且类型匹配。Server 从当前画布生成 resultTarget，不信任客户端注入的目标快照；同节点仅一个非终态任务（独立提示词优化除外）。重试保持原冻结输入，但再次检查节点是否存在、类型及并发锁。

```ts
type ContentSnapshot = {
  kind: 'text'|'image'|'video'|'audio'; revision: number;
  assetId?: string; text?: string; html?: string;
};
type NodeResult = {
  version: 1; id: string; jobId: string; projectId: string; nodeId: string;
  base: ContentSnapshot; operation: string; createdAt: string;
  outputAssetId: string; output: PublicAsset & {text?: string};
};
```

归档与任务成功在原事务中保存唯一 `node-result`（id=jobId）。重复完成不会追加记录；失败、取消、未归档输出不发布结果。`GET /api/v1/projects/:id/node-results` 需访问凭证，按归档顺序返回；签名素材 URL 在读取时生成，文字结果附正文。项目关闭和 Server 重启不丢失账本。

画布仍使用 schemaVersion=1，内容子结构 contentSchemaVersion=1。新增 contentRevision、versions、receivedResultIds、titleSource 和 languageSelection。versions 每节点最多 1000 项，画布仍受整体请求体限制；超限返回明确错误，不静默裁掉历史。版本与确认集合通过画布 baseRevision 乐观锁持久化。未知 contentSchemaVersion 拒绝保存，不推测转换。

Studio 的本地媒体结果使用独立 result id，不伪造 Server jobId；结果 reducer 与后台任务共用。新结果只在 base 与当前内容完全一致时采用；用户编辑过内容时保留在历史。常规草稿变化不增加 contentRevision，替换内容／恢复版本／撤销会推进 revision。

Worker 不管理项目和节点，也不接收这些 UI 版本字段。Worker 3.0 信封、执行规格身份和三类独立队列不变。
