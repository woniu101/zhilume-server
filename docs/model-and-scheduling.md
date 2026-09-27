# 模型接入与任务调度基线

适用版本：Studio 0.13、Server 0.10、Worker 0.9。协议信封 3.0、契约快照 3.0.0、能力目录 1.7.0。初版直接重构，不提供旧开发版兼容。

## 职责与执行位置

| 组件 | 职责 |
|---|---|
| Studio | 画布创作、模型/规格选择、参考素材、任务提交与结果审阅 |
| Server | 项目和素材归档、互联网模型密钥、能力登记、全局队列与依赖调度 |
| Worker 核心 | 接入鉴权、能力声明、租约、文件传输、独立执行器与进程管理 |
| Worker 管理页 | 本机环境、执行器、接入配置、资源状态及诊断；不管理项目 |

图片裁剪/拼图/宫格切分仍由 Studio 本地处理。视频截取/抽音轨：Web 走 Server FFmpeg，Electron 走 Studio 内置 FFmpeg，复用同一媒体模块。GPU Worker 不参与基础媒体处理。GPU、互联网模型、Server FFmpeg 分开排队，后者并发固定 1。

Qwen 内部文本编码器和 IndexTTS 文字情绪模型不是通用语言模型。`text.generate.v1`、`prompt.optimize.v1` 是独立能力，所有图片/语音/视频生成均可直接提交，无需优化步骤。

## 模型执行规格

`profileId` 是公开执行规格规范化 JSON 的 SHA-256，不是机器配置文件摘要。对象字段排序，数组顺序保留，UTF-8 编码。公开规格含：

- modelId、workflowRevision、支持操作；输入数量/尺寸/时长/文本限制；输出格式和固定参数。
- identity.revision、quantization、各权重组件 artifacts。组件使用 `sha256:<64 hex>` 或明确、不可变的 `revision:<identifier>`，禁止示例占位符。
- 同名模型不同版本、量化、工作流、能力限制得到不同 profileId。任务必须指定已登记的精确规格；不会自动换模型或换规格。

本机 Python、ComfyUI URL、模型文件名/目录、工作目录和设备配置保留在 Worker 管理配置内，不加入规格摘要。不同路径但相同执行规格可跨 Worker 等价匹配。声明的权重身份由部署者核对，环境检查不等于重新计算全部大型权重的哈希。

Worker hello 的 `executionSpecs` 为 `{kind: image|speech|video, spec}` 列表；`deployment` 为 `{capacity:1, resourceIds:[GPU_UUID...]}`。Server 校验各类规格与摘要后持久登记。已登记规格离线后仍可选择并排队；从未登记的规格不可猜测参数提交。

Studio 按模型及规格聚合，展示版本、量化、就绪执行端数量，默认自动选择匹配空闲 Worker。高级选项可固定 Worker；指定执行端离线会等待，不静默切换。执行端数量是 Worker 数量，不是独立 GPU 数量；共享 GPU 仍受资源互斥约束。

## 队列与资源

- GPU：每 Worker 容量 1，多 Worker 可以并行。先验证操作/规格/参数和可选 Worker 约束，再分配空闲资源。按提交先后扫描可执行任务，离线/忙碌任务不阻塞后面的独立任务。
- API：全局并发 2，每服务并发 1；不占 GPU 或 FFmpeg 配额。服务停用的任务保留排队并展示原因。
- Server FFmpeg：并发 1；不要求 Worker 在线。Electron FFmpeg 由主进程管理，位置不自动切换。
- Worker 当前保守独占本机可见 GPU 集合，用 NVIDIA UUID 声明物理资源。不同 Worker/容器必须共用主机资源锁目录；容器挂载同一目录，不能各自生成独立锁空间。
- Server 在结果归档后仍根据 Worker activeAttempts 保持资源占用，直到执行器卸载/停止确认。Worker 每次调用前持久写入资源使用标记，正常释放才清除；异常退出、卸载失败均不得让另一 Worker 绕过。
- 未确认释放时，只有原 Worker 的原执行器可尝试恢复；不能删除隔离标记强行启用其他执行器。ComfyUI 采用专用服务、空队列、`/free` 卸载与物理显存占用与框架显存检查（连续两次满足空载上限；默认 1536 MiB，可按专用服务空载基线配置 idleVramLimitMiB）；IndexTTS 使用受管独立子进程。本轮上海二 A 针对性实测见验收报告；H3 与异常驱动恢复仍需独立覆盖。

不做自动扩容、显存预测、抢占、云实例购买、SSH、组网或中继。Server 主动连接 Worker，Server 无需公网地址；用户负责网络可达性。

## 任务提交与依赖

`POST /api/v1/jobs`：`requestId, projectId, nodeId?, operation, input, targetWorkerId?`。

`POST /api/v1/job-groups`：`requestId, projectId, mode: batch|workflow, tasks:[{key,nodeId?,operation,input,targetWorkerId?,bindings?}]`；每批 1–100 个任务，原子验证和提交。

- batch：互相独立，可并行，禁止 bindings。
- workflow：仅显式 bindings 形成依赖。普通画布连线只引用已有素材，不触发上游重跑。Server 验证环、重复 key/输入槽、输入类型和目标操作限制。
- binding：`{from:上游key,target:输入槽}`。目标限于 text、prompt、assetId、referenceAssetIds.N、references.N.assetId、speaker.assetId、emotionReference.assetId。数组槽必须预先存在。
- 提交冻结参数、规范化规格、规则修订、已有素材 ID/哈希及画布 revision。后续画布编辑不影响任务。依赖槽冻结的是绑定关系；上游成功且素材完成归档后，填入真实输出并再次校验输入限制。
- 上游失败/取消只阻塞其后代，独立分支继续。下游不会读取上游未归档输出，也不会偷偷改为旧素材。修复后显式重试相应任务。
- requestId 相同且规范化请求内容一致返回原任务/批次；内容不同返回 409。重试保留 Job ID，生成新 attempt/lease；旧尝试不能写回。

| 状态/原因 | 界面含义 |
|---|---|
| queued / resource_busy | 排队，等待空闲执行资源 |
| queued / model_offline | 精确规格或指定 Worker 离线；API 服务停用 |
| waiting_upstream / upstream_pending | 等待上游成功并完成素材归档 |
| assigned、running | 准备输入、执行或结果传输，显示真实阶段 |
| cancel_requested | 正在停止，尚未确认取消 |
| blocked / upstream_failed | 相关上游失败或取消，可在修复后重试 |
| failed、interrupted | 执行错误或租约/进程中断；不自动重复推理 |
| succeeded、cancelled | 结果已归档，或停止已确认 |

## 互联网语言模型

Server 管理台配置 HTTPS API 根地址（本机测试允许 HTTP）、API Key、模型标识、版本、text/vision/structured 能力、默认用途。初版使用 Chat Completions 兼容适配；配置声明不等于第三方真实支持已验证。

接口：GET/POST `/api/v1/language/providers`，GET `/language/models`，GET `/models` 聚合所有模型族。更改执行相关配置创建新规格，已提交任务不跟随改动；密钥轮换沿用服务私有凭证。密钥采用 Server 本地 AES-GCM 密文文件，主密钥与数据应作为私有部署资料保护。页面只回传 hasKey，不回显密钥；项目/画布/Worker 均不存储密钥。

请求 text 最多 20000 字符，可按规格下调；vision 最多 8 张已归档图片、每张最多 8 MiB；仅声明 structured 的规格允许 JSON Schema，Server 验证响应。调用超时 120 秒，限制响应体和文本长度；失败信息不转发包含凭证或供应商原始内容的响应。取消本地请求并丢弃迟到结果，不承诺供应商停止计费。

优化由用户点击触发，可选明确发送参考图片。原稿和建议并列展示，应用后才替换，失败/关闭不改原稿。H3 官方 Skill 被整理为版本化提示词规则，不是独立推理服务；任务同时冻结模式、时长、是否音频等约束。不引入积分体系。

H3 规则依据：[官方 Skill](https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills/h3-prompt-writing)，本地规则修订 `zhilume-prompts-2026-09-27.1`。规则注明基准/参考模式字段、镜头时序、`<Picture N>` 等参考标签，以及保留对白、歌词和画面文字原语言。真实效果需使用用户选择的语言模型评估。

## 界面方案

延续中性灰底、雾蓝强调及深浅主题。创作参数仍放在节点外部浮层；模型版本/量化/就绪数量在规格信息行，固定 Worker 放高级折叠区。文本生成与提示词优化采用明确按钮和审阅区，不自动介入生成。

画布工具栏提供“批量 / 流程”，选中多个节点后提交；“运行流程”逐条确认哪些输入等待新结果。任务列表使用上述中文阶段及重试/取消操作。Server 管理台负责语言服务与多 Worker 总览；Worker 面板不重复项目/画布功能。

Worker 面板有概览、执行器、环境、接入、诊断五页。复杂部署配置暂采用 JSON 编辑器并提供仓库示例；普通安装用户先读取并修正既有环境，再显式检查和启用。服务在线、检查通过、真实推理通过分别展示，不将任何一个状态冒充其他状态。

## Worker 部署管理增量接口

以下接口仅接受部署管理凭证，不接受 Server 调度凭证，模型任务 wire 协议不变：

- `GET /management/api/environment-templates`：三个引擎的配置模板；权重量化与固定组件标识为空，必须根据实际部署填写。模板随 Worker 打包，不依赖源码仓库或 Node。
- `PUT /management/api/executors/{kind}/config`：保存前验证配置结构；无效结构返回 400，不修改原配置。保存仍为异步操作，响应 operationId，完成后停用并清空旧检查结果。
- `overview.executors[].checks`：检查项包含 id/title/state/detail/remedy。state 为 checking/passed/failed/skipped；失败不提前遮蔽其他独立检查项。
- `operations[]`：新增 startedAt/finishedAt，持续运行保持 running，最终 succeeded/failed，result 包含检查明细；不返回内部 task 对象。
- `GET /management/api/executors/{kind}/logs`：最近 60 条脱敏部署事件（尾部读取上限 128000 字节），含开始、结束、检查明细。引擎限定 image/speech/video；读取无写入副作用，服务重启后仍可读。

ComfyUI 服务由部署者管理进程、Python、GPU 和模型目录。Qwen/H3 表单配置服务入口与模型规格，IndexTTS 表单配置本机独立 Python 路径。环境检查不代表 GPU 推理已验收。
