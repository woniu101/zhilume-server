# 编辑浮层与文本操作验收

日期：2026-09-29。Studio 0.15.1 / Server 0.13.1；Worker 未修改，Worker 协议不变。

## 实现

- 共享浮层注册与嵌套归属，参数、参考选择/预览、视频片段、语音参考/情绪、执行端设置、提示词建议和版本历史统一使用 Portal。
- 普通参数靠按钮定位，复杂内容采用独立宽面板；视口避让、尺寸限制、内部滚动、同级互斥、分层 Escape 与焦点返回。
- 节点编辑区固定头尾，正文滚动；打开参数不会扩张主面板。向上定位预留节点工具栏空间，受限高度下表单行不挤压重叠。
- Studio / Server 所有 Electron 窗口注册系统编辑菜单；操作可用性来自 Chromium 编辑状态，不添加剪贴板 IPC。Web 保留浏览器默认文本菜单；Worker 管理页源码没有阻断 contextmenu，本轮无需修改。

Studio 单元测试 `npm test`：11/11 通过，包含节点结果、画布、健康状态与桌面媒体进程校验。

## 浏览器回归

执行 generation、language-tools、node-results、speech、video-generation、media-tools 场景。首次完整相关集 20 项中 17 项通过：参考预览测试的对话框名称歧义已修正，另两个媒体工具用例定位出编辑区遮住节点工具栏，已修复布局。随后定向重跑 5 项全部通过，涵盖上述失败项、新浮层几何断言及文本生成。

新增断言：参数不在 composer DOM 内；打开前后编辑区高度和提示词位置差小于 2px；主面板没有额外溢出；嵌套菜单的 Escape 不关闭外层；关闭返回按钮焦点；反向提示词草稿重新打开仍保留；900×640 视口浮层完全可见。图片、语音、视频、优化建议、节点版本和 Web FFmpeg 场景通过；生成服务为隔离测试夹具，不代表新增 GPU 验收。

深浅主题和小窗口证据：evidence/0.15.1/floating-parameters-{dark,light,small}.png。构建仍有现有大 bundle 提示；测试期间偶见既有 ResizeObserver 通知，本轮未屏蔽该提示。

## Windows EXE

用新打包的 release/win-unpacked 启动隔离数据目录；未改用户项目、凭证与云实例。

- Server 启动器：真实端口输入框右键出现撤销、重做、剪切、复制、粘贴、纯文本粘贴和全选；没有选区时剪切/复制正确禁用。
- Studio：文本节点输入框全选后右键剪切，观察到输入框为空；再次右键粘贴恢复“写一段测试文本”；点击保存，Server 持久化画布中 text 与 textDraft 一致、contentRevision=1。证据 native-canvas.json。
- Studio：图片节点点击输出参数，独立面板浮于编辑区上方，底部生成栏仍在原位；Escape 后仅参数关闭，图片编辑区继续存在。证据 native-output.jpg。
- 两端共用同一原生菜单模块并注册所有 BrowserWindow。Server 管理台和登录框未逐字段重新实测；密码/只读权限委托 Chromium editFlags。

Studio 构建的 5 个入口、资源与原生菜单文件，Server 的 3 个入口/原生菜单文件，与各自 ASAR 逐字节一致。两端打包完成；最新输出固定在各自 release/win-unpacked。

隔离 EXE 与测试服务验收后停止。本轮不下载模型、不运行 GPU、不修改生成调度或媒体执行位置。
