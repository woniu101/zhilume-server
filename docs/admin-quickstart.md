# Server 管理台与模型接入

## 启动、凭证与关闭

EXE 的启动器负责 Server 子进程、端口、数据目录和托盘；点击“启动并打开管理台”后自动打开已登录的管理台。管理台是同一套 Web 页面，关闭管理台不会停止 Server；启动器运行期间关闭窗口会收起到托盘，停止服务或“停止并退出”才结束自有进程。

终端：`npm run build` 后 `npm start`（开发用 `npm run dev`）。日志显示管理台地址、数据目录和凭证来源，不打印密钥。在相同工作目录和相同环境变量下运行 `npm run credential` 获取访问凭证，然后访问日志中的 `/admin/`。若配置 `ZHILUME_TOKEN`，凭证来自该变量；否则是 `ZHILUME_DATA/admin-token`。默认终端数据目录为仓库 `.data`；EXE 为启动器显示的用户数据目录，两者不自动共享。需要共享时显式配置同一数据目录，且不要同时启动两个服务访问它。

“已连接 Server”仅表示管理台能访问 Server，GPU 是否可用由执行端状态单独表示。没有 Worker 仍可管理项目、素材、API 模型和执行 Server FFmpeg 任务。

## 云 Worker 接入

优先使用平台原生 HTTP/HTTPS 服务映射。Worker 在实例内监听 `0.0.0.0`，将所选内部端口映射到平台提供的服务域名或外部端口。Server 管理台填写从 Server 机器可访问的根地址，不带 `/management`。平台的网页登录认证页不能代替 Worker 接入鉴权；入口必须同时允许 HTTP API、文件传输和 WebSocket。测试连接只证明 HTTP 探测通过，保存后以执行端在线、心跳更新为 WebSocket 建连依据。

Server 主动连接 Worker，不要求 Server 有公网地址。平台不支持所需协议时，用户自行解决网络可达性；本项目不提供 SSH 隧道、组网或中继。

- 优云智算支持 HTTP/TCP 端口映射：[官方文档](https://www.compshare.cn/docs/gpus/instance/updatecompshareinstanceports)。以实例当前配置为准。
- AutoDL 自定义服务支持开放端口与域名映射，资格及端口限制以[官方文档](https://www.autodl.com/docs/port/)和账号控制台为准。

## 语言模型

语言模型页分为 API 服务与 Worker 模型。API 新增服务先选预设，再填 Key，获取模型目录或手动输入模型 ID，可为同一服务配置多个模型。默认用途分别选择文本、通用、Qwen 图片、H3 视频提示词。高级设置折叠展示版本、输入输出限制和模型支持的思考/结构化参数。

预设仅提供可编辑的地址与协议，不保证账号、套餐、区域或所有模型支持每项能力。纯文本默认支持；图片理解和结构化输出须按模型实际能力勾选。“获取模型列表”只查询目录，不生成内容、不证明真实推理通过；平台不提供目录时可手动输入。API Key 不返回页面、不进入画布或 Worker。改地址或协议必须重新输入 Key；尚未运行的旧连接任务停止分配并提示取消后重新提交，防止将新凭证发到旧地址。

三种协议：Chat Completions、OpenAI Responses、Anthropic Messages。三者分别编码图片、系统提示词和结构化参数，并检查完成/拒绝状态。参考：[Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[Messages](https://platform.claude.com/docs/en/api/messages/create)、[Gemini 兼容接口](https://ai.google.dev/gemini-api/docs/openai)。本次协议回归使用本地模拟服务；服务商真实模型、额度和能力仍须按实际账号验收。

新增鉴权接口 `POST /api/v1/language/providers/discover`，接收 `id? / baseUrl / protocol / apiKey?`，返回 `{models:[{id,name}],elapsedMs}`。仅在原地址和协议一致时允许复用已保存密钥；不保存表单，不执行推理。`POST /language/providers` 的 `protocol` 支持上述三种值，其余任务冻结、取消、归档协议不变。

## 素材与诊断

素材页显示 Server 机器上的实际目录，支持名称搜索、类型筛选及图片/视频/音频/文本预览。本机 EXE 管理台可打开该固定目录，普通浏览器只能查看/复制路径，不会尝试打开远端机器文件夹。归档文件名使用素材 ID；不要手动改动归档文件，以免破坏项目引用。

服务设置展示运行版本、协议版本、数据目录、凭证来源和连接地址。脱敏诊断仅导出版本、数量、任务 ID/状态/操作与执行端 ID/状态，不包含 Key、提示词、素材内容、原始错误响应或本机路径。

## 发布目录

Studio 与 Server 各自执行 `npm run pack`，最新可运行目录固定为 `release/win-unpacked`。不要传入临时版本目录覆盖构建输出。程序升级不覆盖用户数据目录，打包结果不包含运行凭证、项目或素材。
