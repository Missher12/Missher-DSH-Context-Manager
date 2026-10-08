---
description: "查看会话上下文组成与摘要来源，并按阈值在请求前压缩历史。"
kind: "package-bundle"
---

# Missher DSH Context Manager

中文 | [English](./README.en.md)

[桌面端](https://github.com/Missher12/Missher-DeepseekHarness-Desktop) · [下载与版本](https://github.com/Missher12/Missher-DSH-Context-Manager/releases) · [问题反馈](https://github.com/Missher12/Missher-DSH-Context-Manager/issues)

在 DeepSeek Harness 的会话中查看上下文组成、用量、压缩记录和摘要来源，并在模型请求前按阈值压缩历史。支持任务正常结束后的闲置整理；这项能力需要下文列出的宿主接口。

包名为 `@missher/dsh-context-manager`，当前版本为 **0.9.0-local.1**（预发布）。这是可单独安装的 Cordis Bundle，仓库与安装包均包含对应的十二个运行文件；[本版下载与验证范围](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/PUBLICATION.md)列出安装、备份与验收结果。

继续保留：可证明无损的摘要包装归一化（BOM、换行、单一 JSON 代码围栏）；至多一次有预算的格式修复，仅当数组字段误写为单个字符串时触发，失败正文完整重发并逐字段比对，其余结构问题一律拒绝且原文保留；可配置的「绝对工作历史软预算」（默认关闭，与百分比、输出预留、安全空间取保守值）；取消后的迟到用量幂等补记；上下文页显示有效预算来源与 Goal 停因。


### 0.9 工作集压缩

默认采用自动工作集：近期原文预算 20K、摘要输出上限 8,192 Token，系统指令、工具定义和最新任务单独计量。近期预算是偏好，空间不足时按完整工具组缩减；并非把压后总量固定在 50% 或 100K。用户仍可选择自定义百分比／绝对占用上限，保存的旧值不会丢失。

压缩前检查整个保留部分能否入线；摘要完成后再次校验带包装的完整占用和净收益，不满足即保留原文。已有安全裁剪接口时先整理已完成的旧文本工具结果；错误、富媒体和近期内容保留。同一批原文跨步骤、跨重启最多领取两个主摘要计划、四次模型调用；需要足够新增原文才开启下一周期，相同请求不自动重发。人工重试仍受单事务四次调用和一次格式修复限制。许可记录不等于费用：实际调用仍逐次进入原用量账本。

新增同会话原文工具 `context_history_search`、`context_history_read`，分页读取已被压缩／裁剪的原始文本及精确位置，不写 MSE、不访问其他会话、不使用向量服务。只覆盖文本，非全文索引；每次最多扫描 200 个事件／32,768 字符，输出 JSON 不超过 8,000 字符，可分页的未覆盖尾部给出继续位置；超过单事件块数或日志上限时明确拒绝。

上下文面板保留 DSH 原生布局。当前准入读实际 TokenMeter；历史、未加载或缺少输出预留时显示未知，趋势保留估算口径。真实模型摘要保真仍需单列验收，结构合法和内容变短不构成保真证明。

### 保留的 local.9 通用恢复修复

同一个插件包用于各平台。修复 Windows 恢复日志初始化的目录 `fsync` 错误，并保留普通文件刷新失败时的拒绝行为；POSIX 仍刷新目录。Windows 的发布文件会在原子替换后以可写句柄再次刷新，日志锁、幂等补记、取消与任务原文保护不变。Windows 权限继承 profile 的 ACL，不能用 `0700/0600` 声称等同 POSIX 权限或承诺突然断电的目录耐久性。完整桌面/用户会话验收与原生文件系统测试分开记录。

摘要错误现保留原生故障类型，允许宿主既有图片卸载钩子识别明确的图片超限；不会把任意错误都变成自动重试。每次实际摘要调用继续分别记账。

## 宿主与平台

本版在 macOS Intel 上通过增强 SDK 237 项（235 通过，2 项旧 SDK 专用）和自然旧 SDK 48/48 回归；并在当前 Missher 定制 rc.2 桌面完成整组加载、实际安装、重启和只读 RPC 检查。local.9 的三端原生恢复日志回归是历史证据，新工作集的 Windows/Ubuntu 完整桌面与真实模型验收仍单列。详见[发布说明](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/PUBLICATION.md)。

| 运行条件 | 本插件行为 |
| --- | --- |
| Host 的 Session、Projection、TokenMeter、StorageDomain、BasicCompactionEngine，以及 Web 会话视图、设置、Remote 和共享 UI 服务可用 | 提供请求前压缩与只读上下文页 |
| 通过 DSH profile 启动，插件恢复目录可独占读写 | 插件检查最终取消状态后同步提交摘要；已收到用量先进入恢复日志，再写原数据域 |
| 宿主没有新增取消标记、存储排空或维护选区钩子 | 使用插件自己的事务、恢复日志及选区逻辑；不修改宿主、不另装兼容包 |
| 没有 profile 路径的自定义嵌入环境 | 仍需宿主存储排空能力；否则在付费调用前拒绝 |
| `toolResultPruner.supportsProtectedSeqs === true` | 先整理旧文本工具结果；保护当前任务、错误及非纯文本结果 |
| 缺少保护裁剪能力 | 跳过工具结果整理，保留正常摘要路径 |

包不按 DSH 版本号设置硬性准入范围；这不等于兼容所有版本。必要服务缺失仍会加载失败。可选能力按上表降级，无需另装兼容包。预设文件基线与能力说明见 [COMPATIBILITY.json](./COMPATIBILITY.json)。其中 `sourceSha` 是生成预设的源码基线，不是纯官方整包验收声明。

## 安装与更新

优先下载 [GitHub Release](https://github.com/Missher12/Missher-DSH-Context-Manager/releases) 的预构建 `.tgz`，按该 Release 的 SHA256 校验。它包含运行入口，不要求用户安装 SDK 或在电脑上编译。只使用已实际发布的版本资产。

桌面端：等待任务结束并备份 profile 与数据，进入 **插件 → 添加插件**，选择 [0.9 安装包](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.9.0-local.1/missher-dsh-context-manager-0.9.0-local.1.tgz) 或填写该下载地址，更新现有同名插件。无需安装 SDK、本机编译或另装兼容插件；没有安装期构建脚本。

备份须同时保留会话、`context_manager_idle`、`context_manager_summaries`、新增的 `context_manager_cycles` 和 profile 内 `.context-manager-recovery`。回滚后保留周期元数据，避免再次升级时丢失防重复记录；不要用旧备份覆盖后续工作。

CLI/Web：将 `my-context` 替换为你正在使用的自定义 Web profile；桌面的保留 `desktop` profile 应在应用内管理。

```sh
dsh plugin --profile my-context add https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.9.0-local.1/missher-dsh-context-manager-0.9.0-local.1.tgz
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
| 触发占用 / 保留策略 | 80% / 自动工作集 |
| 近期原文偏好 / 摘要输出上限 | 20K / 8,192 Token |
| 自定义占用上限（默认不生效） | 保存 55%，仅自定义模式启用 |
| 提前检查 / 安全空间 | 1% / 2% |
| 每请求最多压缩 / 单次摘要超时 | 2 次 / 90 秒 |
| 闲置整理 / 闲置时长 | 开启 / 15 分钟 |
| 闲置最低占用 | 自动模式为 65%；自定义为 max(65%, 目标 + 10%)，最终不超过有效检查线 |
| 绝对软触发 | 默认关闭；保存的起点 200,000 Token；启用后自动模式也生效 |
| 绝对压后占用上限 | 保存 100,000 Token，仅自定义模式且绝对预算开启时生效 |
| 格式修复 / 修复输出上限 | 开启 / 2048 Token，同一事务最多一次 |
| 额外摘要重点 | 空，最多 2000 字符 |

百分比检查线为 `max(0, min(窗口 × 触发比例, 窗口 − 输出预留 − 安全空间) − 提前检查空间)`；启用绝对预算后再与绝对软触发取较小值，不重复扣除提前量。自动模式基于当前固定内容、受保护任务、近期原文和摘要规划总占用，不套用固定压后比例。自定义模式另受百分比目标、百分比检查线的 80% 与启用的绝对软目标中的较小值约束。旧 200k → 100k 仅为早期验证起点。它在新任务已经进入请求后测量，包括系统指令、工具定义等；必要时先整理再执行主请求。TokenMeter 可能使用估算值，目标占用不是精确分词或无损承诺。

摘要使用会话的实际模型和推理级别，可能产生 API 费用并改变缓存命中。摘要包含目标、约束、完成、待办、证据、下一步与未知事项；结构校验不保证语义无损。失败、取消、未完成、没有缩减或超过次数时停止本次尝试，不无限重试。已提交的工具整理不会因此撤销，原始记录仍可查询。

闲置从任务**正常完成**起计时，后台忙碌时有界延后；新消息、模型切换、停止或停用会使旧计划失效。每个完成资格最多发起一次闲置摘要，先持久登记再请求。重启只恢复已登记且重新加载会话的未尝试资格，至少等待 5 秒复查；未知结局的在途请求不会重复计费重发。新输入使请求前摘要取消时，新任务留在宿主队列；不保证当前宿主自动唤醒，应按停止原因继续。应用退出时不运行，不扫描或激活所有旧会话。

选择内置官方 DeepSeek 路由时还会显示峰谷时段与费用比较提示，第三方路由隐藏。它使用插件内 **2026-09-29 的价格政策及 2026 年日历快照**，不是实时价格服务；未知模型或年份不补造。实际费用以 [DeepSeek 官方价格说明](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)和账单为准。

## 停用、卸载与数据

- 关闭设置中的“自动压缩”会停止请求前和闲置自动整理，仍保留安全窗口拦截。仅关闭“闲置自动压缩”可保留请求前压缩。面板与宿主手动 `/compact` 仍可使用。
- 停用整个 Bundle：在应用的插件管理中停用本包，按宿主提示重启。卸载也使用同一入口，等待任务结束后操作；CLI/Web 可使用 `dsh plugin --profile my-context remove @missher/dsh-context-manager`。
- 禁用/移除 Bundle 的配置叠加后，重启让宿主重新创建原预设与压缩器。若自己在自定义预设中引用了本插件，卸载前先恢复相应 Basic 压缩器引用。不要仅删除三个内部入口中的某一个。
- 插件没有卸载清理脚本。会话、成功摘要及来源引用继续由宿主会话日志保存；不会因卸载本包而主动删除。已完成的压缩不会自动逆转，原文可通过宿主查询或本插件追溯。
- profile 内 `.context-manager-recovery` 只保存尚未确认写入的用量及闲置元数据，不保存对话正文。重启核验旧行后按相同 attempt ID 补记；不重发模型、不重复收费。冲突、损坏或独占锁不明会拒绝继续。旧宿主退出后才到达、插件从未收到的用量仍标未知。
- 元数据保存在宿主 `storageDomain` 的 `context_manager_idle`（闲置资格/状态）及 `context_manager_summaries`（摘要调用状态/实报用量），以及 `context_manager_cycles`（请求哈希、原始来源水位和调用许可）中。失败摘要原始输出不持久化；成功提交的输出与来源保存在会话日志中。未知用量不是零。
- 升级或回滚应完整备份目标 profile、插件数据域和会话目录；不要只保存 `.tgz`。元数据域没有新增会话迁移。此插件不维护 MSE 长期学习库，也不自带独立分析上报端点；摘要内容经宿主发送给所选模型提供方。宿主自身遥测遵循宿主设置。

## 验证与限制

本轮完成增强 SDK 构建与 Host/Client 类型检查、235 项通过（2 项旧环境专用另跑）、自然旧 SDK 48/48、协调者独立 40/40，以及当前桌面隔离整组加载和 macOS 实际安装。日常 175 个启用项全部 active、11 份前端字节匹配；没有调用真实模型。版本、绑定哈希与分层结果见 [PUBLICATION.md](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/PUBLICATION.md)。

合成长任务回放验证了压缩间隔、来源回查、配对及计费协议；不能证明真实模型摘要的信息保真、吞吐或收益。Windows/Ubuntu 完整桌面、Apple Silicon 和其他官方宿主需要各自验收。压缩后重试不会完整重跑宿主 `preStep` 动态装配，需要用现有工具核实文件和任务状态。历史证据保存在 [verification](https://github.com/Missher12/Missher-DSH-Context-Manager/tree/main/verification)。

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
