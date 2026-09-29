# 现有云实例 → Server → Studio 全流程试跑

2026-09-29 只读查询：上海二 A 的 `zhilume-dev-sh2-20260926-1556`（`cpod-1vr0loee4x8y`）及 `Zhilume-Fresh-Install-Acceptance` 均为 Stopped。本指南使用前者，已有部署脚本及验收记录对应此实例；没有启动实例或运行 GPU。

## 1. 启动现有云实例与 Worker

在优云智算控制台启动 `zhilume-dev-sh2-20260926-1556`，不必新建或重新安装。等待实例运行后，从平台终端检查控制服务（不是运行模型）：

```bash
supervisorctl -c /usr/supervisor/supervisord.conf status zhilume-foundation
# 仅状态为 STOPPED 时执行：
supervisorctl -c /usr/supervisor/supervisord.conf start zhilume-foundation
```

如果是 FATAL / BACKOFF，请先看日志，不要启动第二个 Worker 进程。

已有部署记录：程序 `/opt/zhilume-managed/current/bin/zhilume-worker`，状态 `/opt/zhilume-foundation-state`，监听 `0.0.0.0:4320`。实例仍停机时无法确认磁盘上是否又被手动修改，以开机后的实际检查为准。

在平台服务/端口映射中找到实例内部 **4320** 的 HTTP(S) 入口。浏览器访问 `入口根地址/management`。这是 Worker 控制端口；不要把 ComfyUI 的 8188 地址填到 Server。

首次登录部署管理台，在平台终端执行以下命令取得管理凭证：

```bash
/opt/zhilume-managed/current/bin/zhilume-worker   --state /opt/zhilume-foundation-state --show-management-token
```

登录后：

1. 概览检查实例、磁盘、绑定状态。
2. 环境页选择已有的 `comfy-main`，先检查，再启动。Worker 重启后托管环境默认停止，不能只看服务在线。
3. 执行器页对 Qwen 图片、H3 视频、IndexTTS 语音分别检查已有配置、模型，再启用接单；无需重填已保存路径。图片和 H3 共用已有 ComfyUI；IndexTTS 由任务按需启动专用进程。
4. 若用本地语言模型，再检查并启用“通用语言模型”。已有部署记录为 Qwen3.5-9B；Qwen3.8-27B 的单独基准测试不表示生产配置已切换。
5. 接入页点击“复制接入凭证”，留给 Server 使用。它与部署管理凭证不同。

## 2. 启动本机 Server 并接入 Worker

打开最新 `zhilume-server/release/win-unpacked/Zhilume Server.exe`。

- 点击“启动 Server”，等待“服务已就绪”，再点击“打开管理台”。启动服务不会自动弹出管理台。
- 接入执行端：名称自定，地址填平台的 **4320 服务根地址**，密钥填 Worker 的“任务接入凭证”。测试 HTTP 连接，再保存；列表出现在线、心跳更新才算完整建连。
- 若提示已绑定其他 Server：确认旧测试 Server 不再使用此 Worker，在 Worker 接入页解除旧绑定，然后重新保存连接。不要删除状态目录或重新生成身份。
- 若平台入口只返回登录页或 WebSocket 握手失败，尚不能用于 Server 任务连接；须调整平台映射/访问设置或由用户解决网络可达性。项目本身不创建 SSH 隧道。
- “已连接 Server”表示管理台与本机 Server 正常，不等于 Worker/GPU 已就绪。

可选语言 API：进入“语言模型 → 添加服务”，选 DeepSeek 等服务商，填 Key，获取模型列表或填写实际模型 ID，设为文本生成与相应用途的默认模型。也可使用上一步启用的 Worker 语言模型，不必两种都配。提示词优化是可选操作。

## 3. 连接 Studio

打开 `zhilume-studio/release/win-unpacked/Zhilume Studio.exe`，Server 地址填启动器显示的地址（默认 `http://127.0.0.1:4310`）。点击 Server 启动器“复制访问凭证”，粘贴到 Studio 登录。这里既不是 Worker 接入凭证，也不是模型 API Key。

终端与 EXE 默认共用启动器配置、数据目录和凭证，切换启动方式能看到相同项目与素材。不要同时启动两个服务使用同一目录或端口。显式设置 ZHILUME_DATA 时，凭证命令也需使用该设置。

## 4. 先手动跑通每项能力

1. 新建测试项目，添加文本节点。单击展开生成区域，选可用语言模型，输入简短要求并生成，确认文本结果已回到节点。
2. 添加图片节点，选 Qwen Image 2512 或 2.1 的可用规格，用简短提示词与默认参数生成一张图。第一次先验证通路，不追求大批量或高分辨率。
3. 图片成功后添加视频节点，选择支持首帧输入的 H3 规格，把刚生成的图片放入首帧参考槽，填写动作提示词，选择界面允许的短时长参数，提交并播放结果。
4. 添加音频节点，选择 IndexTTS，输入短句并选择一段你有权使用的清晰音色参考音频，提交并播放。不要只输入文字而遗漏该模型需要的音色参考。
5. 到 Server“任务队列”核对成功状态，在“素材存储”确认结果归档。

单 GPU 实例一次执行一个 GPU 任务，排队属于正常行为。首次环境检查、加载模型可能更慢；页面“在线”“环境检查通过”和本次“任务成功”是不同状态。

## 5. 再测试依赖流程

普通画布连线引用已有素材，不会自动重跑上游。先为各节点配置好模型、参数和参考槽位，再选择需要运行的节点，点击右上“批量 / 流程”：

- 批量提交：独立任务，使用现有参数/素材。
- 运行流程：在每条连接上明确选择“等待新结果 → 提示词/参考素材”。文本→图片绑定提示词，图片→视频绑定已存在的首帧参考槽。媒体槽位需预先在节点编辑区添加，不能只有一条空连线。

上游成功且结果归档后，下游才会执行；上游失败时只阻塞相关下游。首次建议先跑文本→图片，再加视频，方便定位问题。

## 6. 测试结束

等任务完成，或取消并等待确认资源释放。在 Worker 面板按需停止托管运行环境，然后在优云智算控制台停止 GPU 实例。仅关闭 Studio、Server 管理台或浏览器不会让云实例停止计费。
