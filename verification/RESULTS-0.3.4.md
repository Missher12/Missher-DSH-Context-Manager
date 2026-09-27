# 0.3.4 官方模型选中即显示峰谷

2026-09-28。用户纠正：显示条件仅是选择官方 DeepSeek 模型，与上下文百分比或是否开始对话无关。

## 结果

- 峰谷提示移到模型选择器旁，使用公开 `conversation.input.right`，可覆盖空白新会话的 hero 输入区。
- 共享宿主 `modelDirectories` 的 `current` 状态，包含目录默认模型与已接受的会话模型选择；不增加 RPC，不等历史用量。未确认或失败的切换仍跟随选择器当前值。
- 选中官方 DeepSeek 显示峰谷，选中非官方隐藏；图标、灰色文字、Tooltip 延续现有 DSH 风格。
- 上下文紧凑面板及只读行为不变。7 个后台 lib 文件与 0.3.3 字节相同。

## 验证

- 构建及 Host / Client 类型检查通过。继承的宿主 esbuild `es2024` target 警告不影响构建产物。
- `tests/settings.test.mjs` + `tests/deepseek-period.test.mjs` 共 10 项通过，覆盖无历史默认官方模型、待确认与失败切换、订阅释放、设置及只读面板回归。
- 14 文件 tarball 边界通过，无 Bridge 代码、依赖、安装补丁或 verification 文件。
- 使用实际已装 DeepSeek Harness ASAR、Node 24.18.1 与隔离 DSH_HOME 进行本地目录安装、冷启动：主服务、engine、inspector 均 active。
- 在该真实运行时的隔离 Web UI，新会话尚未发送消息且上下文百分比控件数量为 0 时，官方峰谷链接数量为 1；切到离线非官方模型为 0；切回官方为 1。全新页面浏览器 error 日志为 0，全程无模型调用。
- 首个候选实际冷启动暴露 `remote.session` 注入遗漏；原因是模型目录服务按调用者 Cordis scope 检查依赖。补齐声明后重构建、重装并全新页面复验。失败件和日志保留于 `first-candidate-0.3.4/`，不用于交付。
- 0.2.1、0.3.0、0.3.1、0.3.3 原交付 SHA 保持不变；0.3.4 目录所有包文件与最终 tarball 逐字节一致。

## 交付与范围

- 安装目录：`releases/dsh-context-manager-0.3.4/`
- tarball：`dsh-context-manager-0.3.4.tgz`
- SHA-256：`1d272a516508184a5fba5623a588e6b5328752145d07c2621dc3cfd4d2359633`
- 预览：`http://127.0.0.1:60334/`
- 截图：`native-new-session-official-0.3.4.png`
- 结构化证据：`RESULTS-0.3.4.json`；独立步骤的 JSON / 日志同目录。
- 日常 profile 仍指向独立 0.3.3，未改用户日常安装或重启应用。未操作 Bridge 或共享宿主源码。
- 本次 UI 验证是桌面实际 ASAR 服务的隔离 Web 页面；工具未开放原生窗口控制，不等于原生 Electron 窗口点击验收。未调用外部模型或验证实时账单。峰谷规则和 2026 年日历沿用 0.3.3，其他年份显示待核对。
