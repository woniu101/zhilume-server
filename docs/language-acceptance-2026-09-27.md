# 语言模型接入验收（2026-09-27）

版本：Studio 0.14.0、Server 0.11.0、Worker 0.12.0。

## 已完成

- Server 统一登记互联网 API 与 Worker 语言模型；按执行规格匹配，不因模型名称相同混用配置。API 与 GPU 使用独立队列。
- Worker 增加可选 llama.cpp 执行器，复用已有程序和单文件 GGUF；核心不安装推理依赖。安装路径不参与匹配，程序与模型摘要、版本、量化和限制参与匹配。
- 模型进程在获得 GPU 租约后启动；正常结束和取消均清理受管进程，释放无法确认时隔离资源。
- Studio 支持语言模型选择、Worker 数量与指定执行端；优化保留原稿，应用建议后才替换。Qwen 区分文生图与编辑上下文，中文原稿保留中文。
- PRD、任务协议、模型声明与 Linux 部署说明同步更新；媒体处理位置不变。

## 实测证据与边界

| 验收 | 结果 | 边界 |
| --- | --- | --- |
| DeepSeek 真实 API | 文本、Qwen 建议、JSON 对象及 Schema 校验、H3 规则建议 4 项成功并归档 | 使用用户提供密钥，未调用 GPU Worker |
| Studio 真实页面连接 DeepSeek | 优化、原稿保留、建议显示、明确应用全部通过，无页面异常 | 真实 API 响应，不是拦截返回的固定数据 |
| Studio 自动化 | 2 项通过 | 覆盖建议应用、失败、Worker 选择与重试请求标识 |
| Server 完整回归 | 23 项中 22 通过、1 项 Linux 部署测试在 Windows 跳过，0 失败 | 包含图片、语音、视频传输和 Server FFmpeg，推理使用测试执行器 |
| Worker 单元测试 | 53 项中 48 通过、5 项 Linux 专用测试在 Windows 跳过 | 语言执行器 5 项再次通过；进程与响应使用受控替身，非 GPU 实测 |
| 多 Worker 集成 | 相同规格聚合、两任务并行及第三任务排队、取消、离线绕过、幂等、依赖失败隔离通过 | 真实 Python Worker 与 Server 通信，推理使用轻量测试执行器 |
| 构建 | 三端前端/类型构建及 Worker wheel、Linux bundle 成功 | Windows 目录发布包已生成，未重新完成 EXE 原生交互验收 |

API 验收脚本：`scripts/accept-language-api.mjs`；界面验收脚本：`scripts/accept-language-studio.mjs`。两者均要求显式 `--execute`，会发起真实 API 请求；前者从 `ZHILUME_API_KEY_FILE` 读取密钥，不在日志输出密钥。

本地证据位于 `artifacts/language-api-result.json` 与 `artifacts/language-studio/`（忽略提交）。第一轮 API 的 Qwen 建议曾返回英文，随后加强规则并增加操作上下文；最终真实 Studio 验收返回中文新图描述。原始报告保留这一过程，不覆盖成虚假的全程一致结果。

DeepSeek 密钥当前仅配置于独立验收 Server 的私有 `.data/language-development` 加密凭证库；未修改用户正在运行的旧 Server 配置。私有数据库、凭证和测试项目不随发布包或 Git 提交。

## 尚待云端验收

后续已完成受测组合的云端验收，见 [Worker 语言执行器真实 GPU 验收](worker-language-gpu-acceptance-2026-09-27.md)。以下保留本轮 API/控制面验收结束时的边界，不能将后续结果倒填为当时已验证。

1. 选定具体 GGUF 版本、量化及 llama.cpp CUDA 构建，填写实际 SHA256；目前没有已通过真实推理的默认 Worker 语言模型。
2. 在 Linux GPU 实例验证加载、生成、取消、显存释放、重启残留处理及与图片/视频执行器切换。
3. 验证干净安装、复用已有环境两条部署路径。环境检查、控制链路测试不能替代真实推理验收。

本轮未在本机或 WSL 安装大型模型、运行 GPU 推理，也未启动云端 GPU。进入真实 GPU 测试前通知用户。
