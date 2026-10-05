---
description: "查看会话上下文组成与摘要来源，并按阈值在请求前压缩历史。"
kind: "package-bundle"
---

# Missher DSH Context Manager

中文 | [English](./README.en.md)

[桌面端](https://github.com/Missher12/Missher-DeepseekHarness-Desktop) · [下载与版本](https://github.com/Missher12/Missher-DSH-Context-Manager/releases) · [问题反馈](https://github.com/Missher12/Missher-DSH-Context-Manager/issues)

在 DeepSeek Harness 的会话中查看上下文组成、用量、压缩记录和摘要来源，并在模型请求前按阈值压缩历史。支持任务正常结束后的闲置整理；这项能力需要下文列出的宿主接口。

包名为 `@missher/dsh-context-manager`，当前源码版本为 **0.7.0-local.2**。这是可单独安装的 Cordis Bundle，不是桌面应用，也不是 Codex 或 Claude Code 的压缩实现。本版仅修订发行元数据、依赖声明与说明，9 个运行文件沿用已验收的 `0.7.0-local.1` 字节。

## 宿主与平台

完整功能的已测基线是 **Missher DeepSeek Harness Desktop 的定制 0.2.0-rc.2，macOS Intel（x64）**。它包含维护选区和保护工具结果的两个扩展。Windows、Linux、Apple Silicon、本包在纯官方 rc.2 上的完整运行、官方 0.2.1-alpha.1 均未完成插件级验收。桌面应用提供某个平台下载，不代表本插件在该平台已验证。

| 运行条件 | 本插件行为 |
| --- | --- |
| Host 的 Session、Projection、TokenMeter、StorageDomain、BasicCompactionEngine，以及 Web 会话视图、设置、Remote 和共享 UI 服务可用 | 提供请求前压缩与只读上下文页 |
| `BasicCompactionEngine.selectMaintenanceRange` 可用 | 在宿主维护锁内选择闲置摘要范围，保留最新完整交互 |
| 缺少维护选区接口 | 明确跳过闲置摘要，不发起该次付费模型请求；手动压缩沿用宿主行为 |
| `toolResultPruner.supportsProtectedSeqs === true` | 先整理旧文本工具结果；保护当前任务、错误及非纯文本结果 |
| 缺少保护裁剪能力 | 跳过工具结果整理，保留正常摘要路径 |

包不按 DSH 版本号设置硬性准入范围；这不等于兼容所有版本。必要服务缺失仍会加载失败。可选能力按上表降级，无需另装兼容包。预设文件基线与能力说明见 [COMPATIBILITY.json](./COMPATIBILITY.json)。其中 `sourceSha` 是生成预设的源码基线，不是纯官方整包验收声明。

## 安装与更新

优先下载 [GitHub Release](https://github.com/Missher12/Missher-DSH-Context-Manager/releases) 的预构建 `.tgz`，按该 Release 的 SHA256 校验。它包含运行入口，不要求用户安装 SDK 或在电脑上编译。只使用已实际发布的版本资产。

桌面端：进入 **插件 → 添加插件**，选择下载的 `.tgz` 或填写其 Release 下载地址。也可使用本仓库 Git URL；仓库已跟踪预构建 `lib`，没有安装期构建脚本。固定 tarball 更适合复现版本。

CLI/Web：将 `my-context` 替换为你正在使用的自定义 Web profile；桌面的保留 `desktop` profile 应在应用内管理。

```sh
dsh plugin --profile my-context add https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.7.0-local.2/missher-dsh-context-manager-0.7.0-local.2.tgz
```

安装前保留旧包与配置，等待任务结束；更新后**完整退出并重启目标应用或 profile**。检查插件版本及三个入口 `context-manager`、`context-manager-engine`、`context-manager-inspector` 全部运行，再打开会话顶部“轨迹”后的“上下文”。旧进程可能缓存包导出表，仅刷新页面或切换开关不能替代重启。不要同时启用旧包名与新包名。

Bundle 替换内置 Basic 压缩器，并为 Standard、PTC、Cordis 预设提供对应压缩器配置；Minimal 使用根实例。由于宿主按 ID 替换整个配置，预设来自已核验的 rc.2 快照；更新宿主后需要重新核对。用户保存的预设覆盖仍优先，自定义预设需显式将 `@deepseek-ai/dsh-compaction-basic` 改为 `@missher/dsh-context-manager/engine`。不承诺自动接管所有自定义预设。

## 使用与设置

“上下文”使用 DSH 原生主题和控件，在一个连续面板中展示：

- **当前组成**：模型总窗口、已用内容、未占用与灰色斜线压缩保留。摘要、工具、对话、指令分别显示估算 Token 数；宿主计量差额显示为“其他占用”。预留依实际检查线计算，不是永久不能使用的硬件空间。
- **变化与用量**：占用柱状图、压缩前后、本会话累计与缓存命中；摘要调用单独计数。缺失数据保持未知，累计 Token 不等于当前占用或账单金额。
- **当前有效内容**：默认显示 4 项和最近 2 条压缩记录，可展开与分页。摘要可沿实际保存的来源引用追溯；正文每段最多 16,000 字符，图片显示引用，不预加载全部历史。

页面只读，不激活 Agent、不发起模型请求、不追加会话日志。只在此视图内隐藏发送区，切回“对话”恢复草稿。完整历史与正文不轮询；面板打开时仅轻量刷新闲置状态。分析上限 50,000 条日志，超过时明确报错。宿主布局标记改变后需要重新验证只读视图适配。

参数只在 **设置 → 上下文管理** 中编辑并保存，更新不会覆盖已保存值。

| 参数 | 默认值 |
| --- | --- |
| 自动压缩总开关 | 开启 |
| 触发占用 / 目标占用 | 80% / 55% |
| 提前检查 / 安全空间 | 1% / 2% |
| 摘要输出上限 | 8192 Token，另受实际模型及请求上限约束 |
| 每请求最多压缩 / 单次摘要超时 | 2 次 / 90 秒 |
| 闲置整理 / 闲置时长 | 开启 / 15 分钟 |
| 闲置最低占用 | 65%，且不低于目标占用加 10 个百分点 |
| 额外摘要重点 | 空，最多 2000 字符 |

实际检查线为 `min(窗口 × 触发比例, 窗口 − 输出预留 − 安全空间) − 提前检查空间`。它在新任务已经进入请求后测量，包括系统指令、工具定义等；必要时先整理再执行主请求。TokenMeter 可能使用估算值，目标占用不是精确分词或无损承诺。

摘要使用会话的实际模型和推理级别，可能产生 API 费用并改变缓存命中。摘要包含目标、约束、完成、待办、证据、下一步与未知事项；结构校验不保证语义无损。失败、取消、未完成、没有缩减或超过次数时停止本次尝试，不无限重试。已提交的工具整理不会因此撤销，原始记录仍可查询。

闲置从任务**正常完成**起计时，后台忙碌时有界延后；新消息、模型切换、停止或停用会使旧计划失效。每个完成资格最多发起一次闲置摘要，先持久登记再请求。重启只恢复已登记且重新加载会话的未尝试资格，至少等待 5 秒复查；未知结局的在途请求不会重复计费重发。应用退出时不运行，不扫描或激活所有旧会话。

选择内置官方 DeepSeek 路由时还会显示峰谷时段与费用比较提示，第三方路由隐藏。它使用插件内 **2026-09-29 的价格政策及 2026 年日历快照**，不是实时价格服务；未知模型或年份不补造。实际费用以 [DeepSeek 官方价格说明](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)和账单为准。

## 停用、卸载与数据

- 关闭设置中的“自动压缩”会停止请求前和闲置自动整理，仍保留安全窗口拦截。仅关闭“闲置自动压缩”可保留请求前压缩。面板与宿主手动 `/compact` 仍可使用。
- 停用整个 Bundle：在应用的插件管理中停用本包，按宿主提示重启。卸载也使用同一入口，等待任务结束后操作；CLI/Web 可使用 `dsh plugin --profile my-context remove @missher/dsh-context-manager`。
- 禁用/移除 Bundle 的配置叠加后，重启让宿主重新创建原预设与压缩器。若自己在自定义预设中引用了本插件，卸载前先恢复相应 Basic 压缩器引用。不要仅删除三个内部入口中的某一个。
- 插件没有卸载清理脚本。会话、成功摘要及来源引用继续由宿主会话日志保存；不会因卸载本包而主动删除。已完成的压缩不会自动逆转，原文可通过宿主查询或本插件追溯。
- 元数据保存在宿主 `storageDomain` 的 `context_manager_idle`（闲置资格/状态）及 `context_manager_summaries`（摘要调用状态/实报用量）中。失败摘要原始输出不持久化；成功提交的输出与来源保存在会话日志中。未知用量不是零。
- 升级或回滚应完整备份目标 profile、插件数据域和会话目录；不要只保存 `.tgz`。元数据域没有新增会话迁移。此插件不维护 MSE 长期学习库，也不自带独立分析上报端点；摘要内容经宿主发送给所选模型提供方。宿主自身遥测遵循宿主设置。

## 验证与限制

历史验证基线（2026-10-03）：真实 AgentLoop/JSONL/存储配合模拟模型，115 项通过；命名修订后 20 项针对性测试通过。定制 rc.2 隔离 Loader/RPC 和受控 Web 深浅主题、1280/800/335px、原文分页、无发送区及卡片等高通过。随后日常 macOS Intel 安装确认三个入口激活及只读 RPC 正常。

这些是分层的历史证据，不代表本次发行在所有平台重新验收。未证明真实模型摘要质量、长期任务语义保留或 Windows/Linux 原生运行。压缩后重试也不会完整重跑宿主 `preStep` 的动态规则/计划装配，需要通过现有工具按需核验文件与任务状态。报告见仓库 [verification](https://github.com/Missher12/Missher-DSH-Context-Manager/tree/main/verification)。

## 独立开发

使用 Node 24 或兼容的宿主开发环境、`package.json` 固定的 pnpm，以及**单独构建完成的同版本 SDK**。不在日常链接目录中构建；先创建自己的开发副本，再执行：

```sh
node scripts/link-harness.mjs /path/to/built-harness
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
npm pack --ignore-scripts
```

链接脚本显式建立本副本的 `harness-sdk` 和开发依赖链接，不构建或修改宿主。`pnpm-workspace.yaml` 的相对 SDK 覆盖仅供开发，不进入安装包；测试并发为 1。运行依赖只来自 npm 与宿主公开包名，没有本机绝对路径或安装钩子。

## 许可与来源

本插件采用 [MIT](./LICENSE)。生成预设和设置布局依据 DeepSeek Harness，保留 DeepSeek 署名；浏览器内嵌 Zod 的 MIT 文本见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。压缩引擎及宿主 UI 作为宿主依赖使用，不内嵌其他插件或兼容包。研究参考过 `bowenliang123/dsh-context`，没有复制其运行代码。
