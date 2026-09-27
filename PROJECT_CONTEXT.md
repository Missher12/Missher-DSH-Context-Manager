# 上下文管理插件

- **当前版本 0.3.4（2026-09-28）**：根 src/lib/package 为权威源码，安装选 `releases/dsh-context-manager-0.3.4/`。用户明确峰谷提示仅跟随是否选择官方模型，和上下文百分比无关。提示移到模型旁 `conversation.input.right`，共享原生模型目录的已接受选择（含新会话默认值），不用发送消息或等待用量数据；非官方模型隐藏。10 项相关测试、host/client 类型检查、14 文件包边界审计、真实桌面 ASAR 隔离目录安装及三个组件 active 均通过。全新浏览器页验证空白会话显示、非官方隐藏、切回官方立即显示，浏览器 error 日志为 0；未发送消息或调用模型。冷启动发现并修复 `remote.session` 调用者依赖漏声明，首个候选及失败日志保存在 `verification/first-candidate-0.3.4/`。7 个后台 lib 文件与 0.3.3 完全相同。结果见 `verification/RESULTS-0.3.4.md` / `.json`，预览 60334。现查日常安装为独立 0.3.3，未改日常 profile 或重启应用；原生 Electron 窗口未点击验收。以下旧状态按时间保留。

- **历史版本 0.3.3**：根 src/lib/package 曾归并为最新权威入口，阶段副本 `verification/work-0.3.3/` 保留。安装选 `releases/dsh-context-manager-0.3.3/`；32 项测试、host/client 类型检查、包边界和桌面 ASAR 隔离 Web 验证通过。默认 3 个指标、3 类组成、2 条压缩记录，其余同页按需展开；上下文页隐藏当前发送区，退出恢复草稿。当时在输入区百分比后追加 DeepSeek 官方峰谷提示，0.3.4 已按用户纠正移到模型旁。时段按北京时间与 2026 年官方假期计算；新年份未核验时明确待核对。结果见 `verification/RESULTS-0.3.3.md` / `.json`。

- 2026-09-27 17:38 最新现场：用户已安装 `releases/dsh-context-manager-0.3.1/`。再次报告 inspector 失败时旧后端 PID 99904 仍从 16:51 运行；用户随后说“你来解决”授权处理。执行时旧桌面进程已退出，已通过 LaunchServices 启动实际应用，新主进程 8237、新后端 8274。对实际日常 profile 包解析表执行只读导入检查，主模块、engine、inspector、typert 全通过；profile 文件未改。见 `verification/daily-restart-result-0.3.1.json` / `daily-cold-import-0.3.1.json`。工具未开放原生应用控制，实际后端页面在工具浏览器被阻止，未尝试绕过。驻留组件 active 状态及原生窗口点击尚未验证，不能写成已通过。后续先现查新进程和状态，不再重复归因旧 PID 或要求重新安装。

- 最新交付 0.3.1：安装入口 `releases/dsh-context-manager-0.3.1/`；完整源代码工作副本 `verification/work-0.3.1/`。当时根目录被日常 profile link 引用，因此曾保留 0.3.0；本轮现查已改为独立 0.3.1 安装目录，已备份并归并根目录至 0.3.3。结果见 `verification/RESULTS-0.3.1.md`。
- 用户最新要求：只有“对话 / 轨迹 / 上下文”外层选择，“上下文”内部所有数据在一个连续面板里，取消总览/内容查看器/变化记录内部页签。0.3.1 已实现并通过桌面 ASAR 运行时的隔离 Web 点击验收及 27 项测试。
- 启用失败已复现并捕获 `ERR_PACKAGE_PATH_NOT_EXPORTED`：0.2.1 卸载再安装 0.3.x 时旧进程缓存 exports，新增 ./inspector 导入失败。安装后必须完整退出重开 DSH；开关插件不够。0.3.1 冷启动三个组件 active。本插件不修改宿主加载器，不宣称已支持这条免重启升级路径。新预览 60334，旧预览 58550 保留。

- 2026-09-27 用户“先做出来我看看吧”授权正式实现。0.3.0 原生 `conversation.view` 注册 order 20，位于“轨迹”后；设置仅保留参数。复用宿主控件与主题，未修改共享宿主或 Bridge。
- `src/inspector.ts` 是只读 Typert 服务，使用公开 `sessionQuery.observeSession`，固定不可变截面、租约 finally 释放、取消与 12 秒上限。`inspector-fold.ts` 复用 canonical foldSurface 和宿主消息投影，七类有效内容、历史原文、工具定义与结构估算、最多 200 条回复、12 条压缩记录。正文 16,000 字符分页、列表 50 条、日志上限 50,000，拒绝不完整分析。不会激活 Agent 或发起模型调用。
- `src/inspector-view.tsx` 接收原生视图绑定的准确 sessionId，不从列表猜测当前会话。总览、内容查看器、变化记录；切换/卸载取消请求，不允许旧会话响应覆盖当前页面。历史是“某次回复之后”的有效内容，非精确请求原文；未知历史容量不伪造。
- 0.2.1 原包、SHA 与前期预览均保留；本轮源码备份在 `verification/before-0.3.0/source.tgz`。压缩 engine/policy 保持原实现。结果与剩余限制以 README / verification/RESULTS.md 为准。

- 2026-09-27 用户要求与任务【DSH】Session-brigde (`01a0e136-a8b3-7cb1-b322-aa0813ec29d9`) 切割维护范围。本任务只写本插件；Bridge 的两行样式修复已移交其负责人。具体文件、服务、UI、配置和交付边界见 `PLUGIN_BOUNDARIES.md` / `AGENTS.md`。不再写 Bridge 项目或替它出包。
- 交付边界审计：`node scripts/verify-package-boundary.mjs` 只读检查既有 tgz；已确认 11 个文件、不含 Bridge 实现/依赖/安装钩子/配置覆盖及 verification 副本，SHA 保持原交付值。此次协调不重打包、不改压缩逻辑。

- 最新修复版 0.2.1：设置页 style 必须带 `data-plugin="dsh-context-manager"`。宿主 claimStyles 会认领整个 DOM 中所有未标记的 style，后续卸载会误删；Effect/React 延迟挂载的 style 不能依赖 factory 自动认领。
- 会话标识错乱已用实际安装 Desktop 的 client-modules 和真实 Cordis Entry 生命周期复现；桥接 style 也必须标记自己的包名。本机桥接源码已同步修复，随后并行工作的本地构建已包含属性及其新业务改动。最终仅交付上下文 0.2.1；旧快照的桥接 0.1.1 包仅留作验证证据，不能覆盖当前构建。`verification/style-ownership/` 保留证据，不改官方源码/日常 profile。
- 模拟 history 种子需要第一个 surface 节点为 system/message；0.2.1 测试已补空系统头和 V4 编码/严格解码校验。旧 v2 测试会话文件保留为失败证据，新 v3 夹具读取通过。

- 用户目标：学习 Codex 的先检查、必要时先压缩、再执行；79.9% 时新任务不能先跑主模型/工具。压缩参数仅放设置页，上下文数据在对话中查看。
- 目录独立于旁边的 `mse/`；禁止覆盖上级 MSE 的 PROJECT_CONTEXT/HANDOVER 或修改用户日常配置。
- 已核验宿主：`/Users/missher/Documents/Deepseek- Harness-Inter`，`0.1.7-rc.2`，SHA 见 COMPATIBILITY.json。依赖链接仅用于开发；打包不含 node_modules。
- `src/index.ts` 提供共享可变策略；`src/engine.ts` 派生官方 Basic，关闭自动监听，使用 llm/stream + agent/request-error 实现请求重建；0.3.0 的 `src/client.tsx` 同时注册 settings.section 和 conversation.view，并挂载自身 Remote。
- 0.1.1 设置页复用宿主 SettingsForm/Button/Input/Switch；`src/client.css` 全部颜色、圆角采用 `--dsw-*`。ui-primitives 是 Web 平台共享模块，不是 dsh.client.inject 的插件行；不得复制第二套组件或另加鲜艳配色。
- 0.2.0 参考 GitHub dsh-context 新增只读概览。`src/diagnostics.ts` 用公开 Session Projection 折叠现有事件；`src/overview.tsx` 读取官方 contextPressure/contextBreakdown/tokenUsage 与有界诊断。组成估算、占用、累计用量不能混算；摘要事件必须配对紧邻替换及结束标记才判定成功。
- 0.3.0 的数据页签位于“上下文”主视图内，仅激活该视图时订阅详情，切走释放详情订阅，无轮询、无额外模型调用。Host 与 Client 分别由 tsconfig.json / tsconfig.client.json 检查，不能混合双方 ctx.sessions 声明。
- 根与隔离 preset 服务要用公开 `agentPresets.serviceFor()` 找到实例；不能仅用 agent.ctx.get 判定。
- `scripts/generate-overlay.mjs` 保留已核验官方预设的配置，只改 provider；配置 overlay 非深合并，自定义/用户覆盖预设不自动接管。
- 验证：npm run build、npm test、npm run typecheck。`verification/profile/` 是临时 DSH_HOME，不是用户工作配置。用真实 AgentLoop 与假适配器统计调用顺序，不调用真实 API。
- 研究依据：上级 `CONTEXT-MANAGER-RESEARCH-20260926.md`；最终实现范围与剩余限制以 README/verification/RESULTS.md 为准。
- GitHub 参考与后续取舍：research/GITHUB-CONTEXT-REVIEW-20260927.md；参考 dsh-context 固定提交 43274f99829cc94347af7f830460a4c8baddb23f，未复制或安装其运行时代码。
