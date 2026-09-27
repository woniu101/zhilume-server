# 独立语言能力与双执行路径

操作保持 `text.generate.v1`、`prompt.optimize.v1`，任务必须指定 `input.profileId`。Server 根据规格登记判定 `executor=api|worker`；客户端不能通过 executor 字段改变执行队列，也不在离线时回退其他模型。

## 互联网 API

沿用 Chat Completions 适配。每个模型明确声明 `text/vision/structured`，并保存 `structuredMode=json_schema|json_object`、`reasoningEffort=default|none|low|high`、`maxOutputTokens`。这些字段加入规格摘要并随提交冻结。

- `default` 不发送思考参数；其他模式发送 `reasoning_effort`，需部署者核实服务支持。
- JSON Schema 模式发送 `response_format.json_schema`；JSON 对象模式发送 `json_object`，系统消息附加 Schema，且限定顶层 object。两者归档前都由 Server 校验；不能将“返回 JSON”视为满足 Schema。
- API Key 只存于 Server 的加密凭证库，不进入模型列表、任务输入、Worker、画布或导出。加密密钥与密文属于私有运行数据，不打包发布。
- 全局 API 并发 2，每服务 1；GPU 与 FFmpeg 队列互不占用。

2026-09-27 官方 `/models` 实际返回 `deepseek-flash`（DeepSeek-V4.1-Flash）和 `deepseek-v4-pro`。本轮选 Flash、关闭思考、输出上限 1024 做验收。只启用已验收的纯文本与 JSON 能力；模型列表声明图片输入不等于本项目已完成图片理解验收。

参考：[DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/)、[模型列表](https://api-docs.deepseek.com/api/list-models/)。当前 Chat 接口声明 JSON 对象模式，不套用 Responses API 的参数。

## Worker

hello 增加 `executionSpecs.kind=language`。规格包含 `backend=llama.cpp`、`workflowRevision=language.llamacpp.v1`、modelId、operations、capabilities、outputFormats、maxImages、maxInputCharacters、maxOutputTokens、contextSize、identity、profileId。首版仅纯文本 TXT。

`reasoningMode=off|auto` 也进入规格摘要；创作默认 off，通过 llama.cpp 模板参数关闭思考。输出触及 Token 上限仍按失败处理，不把截断文本归档为成功。共享库程序在部署配置 `runtimeFiles` 指定本机文件，公开 identity 使用对应 `runtime.*` SHA256；只有摘要参与跨 Worker 等价匹配。

Worker 核心不安装推理依赖。语言执行器通过独立受管进程使用已有程序与 GGUF。它与图片/语音/视频共用 GPU 队列、物理资源互斥及取消/隔离机制。不同路径的同规格聚合，版本、量化、二进制和权重摘要、能力限制不同则分开；高级选项可指定 Worker。

`GET /api/v1/language/models` 返回统一可选项，带 `executor`；Worker 项另带 workers、readyCount、endpointCount、identity。离线规格保留，显示等待原因。Worker 生成结果经文件传输、内容校验后归档；Server 设置 outputText 与 outputAssetId，供依赖和 Studio 审阅使用。

## 创作交互

- 文本节点可选择互联网或 Worker 语言模型。图片/视频优化是主动按钮，不是生成前置步骤。
- 原稿、建议分开显示，应用后才替换。请求失败/取消保留原稿，显式重试产生新请求标识；网络不确定时仍可按原标识幂等重发。
- Qwen 优化携带当前文生图/编辑/参考操作，避免空图片节点被误当作原图编辑；保留用户语言。H3 使用固定修订的官方规则整理，不是独立推理服务。
- 规范化系统提示词和规则修订在提交时冻结；密钥、部署目录不会进入任务。Worker 模型首版不显示图片理解选项。
- 不新增积分、自动扩容、网络组网功能；媒体处理位置不变。
