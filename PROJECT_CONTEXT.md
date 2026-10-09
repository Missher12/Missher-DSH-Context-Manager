# 2026-10-09 自动压缩与紧凑界面公开交付

当前产品为 `0.10.0-local.2`、combined-ui-r5。本公开导出的源码/运行件对应冻结候选；自动压缩与第二版紧凑界面同批发布，精确包、测试与剩余限制见 [PUBLICATION.md](./PUBLICATION.md)。日常安装由协调者单写，发布不代表远端机器已经更新。canonical 未提交工作与旧 lib 保留；下方旧版状态仅为历史。

# 2026-10-09 效率升级候选 CI

当前产品为 0.10.0-local.1 r2，唯一业务写入者已冻结停写，精确包与隔离 Host/存储已独立接受。正式 Git/tag/预发布须由协调者在同候选 12-job CI 全绿后收口；本轮不安装或重启日常。视觉被工具阻断，旧 SDK 额外失败保留。精确绑定与安装说明见 [PUBLICATION.md](./PUBLICATION.md) 和 GIT_DELIVERY.json。下方安装/发布记录属于旧版本；canonical 脏源码与旧 lib 保持。

# 2026-10-08 Context 0.9.0-local.2 日志完整性修复

仅在真实开放任务回合内调用工具裁剪器，避免 idle/manual 回合外 replacement 导致 V4 重载拒绝；摘要与任务内裁剪保持。原文不改，已有坏日志不自动恢复。沿用独立冻结候选，旧 Release、canonical 脏源码和旧 lib 保留。精确安装与发布状态见 [PUBLICATION.md](./PUBLICATION.md)；下方 local.1 是此前阶段。

# 2026-10-08 0.9 当前安装与发布

本公开导出包含已验收的 0.9.0-local.1 源码与十二个匹配运行件。工作集压缩、周期防重复和同会话原文工具由原 Context 负责人单写；协调者独立验收并完成 macOS 日常安装。正式说明、精确包绑定和限制见 [PUBLICATION.md](./PUBLICATION.md)。下方候选、未安装及 canonical 旧 lib 约束是历史记录；canonical 脏源码及旧生成件保持，公开导出的 lib 对应本版本。不要用历史包覆盖新数据。

## 2026-10-08：0.9.0-local.1 自动工作集候选

用户本轮要求先解决记忆压缩，NAS向量接入暂缓。沿用已有 local.9 和未提交工作；不复制并行实现。默认从固定55%总占用切换到自动工作集（近期原文20K偏好、摘要上限8192、固定内容/当前任务独立计量），自定义占用上限及旧设置保留。整个候选必须通过压前可行性和压后实际包装占用检查；原文、工具配对、取消和原用量账本边界延续。

新增context_manager_cycles v1保存同批原文跨步骤/重启许可（2主计划/4总调用，配置或checkpoint新序号不能重置），历史原文工具限定当前会话分页只读。UI继续原生组件、现有布局；准入显示改读实时TokenMeter，与投影趋势区分。保护MSE/Goal及全部日常数据；源码根lib未重建。

本轮隔离构建、反例、测试绑定、包SHA及未验证项见 `/Users/missher/Documents/Deepseek-harness-Cordis/coordination/2026-10-08/context-working-set-upgrade/READY.md`。冻结候选不等于已安装；由既定协调者重新检查空闲、完整备份后安装并验收。真实Qwen与其他平台单列，不能用合成回放声称真实模型信息保真。

# 2026-10-08 Context 0.8.0-local.9 统一维护候选

用户真实 Windows 报错为 `EPERM fsync → syncDirectory → acquire → RecoveryJournal.open`，导致 contextManager 初始化失败，engine/inspector 与恢复会话依赖等待。只在共同恢复日志内部适配底层文件 API：POSIX 保留目录 fsync；Windows 保留普通文件 fsync，并在 rename 后以可写句柄刷新已发布文件，任何失败仍拒绝，rename 后不确定则 poison 至重开。Windows ACL 从 profile 继承，不声称 chmod 等同 POSIX 私有权限；不承诺突然断电或网络盘目录耐久。

全源码审查另外发现摘要流错误包装丢失 LlmError，使官方旧图片卸载恢复钩子无法识别 IMAGE_OFFLOAD_REQUIRED。最小修复保留原 cause/finish failure，并只在公开恢复边界提供原类型；未知故障不自行重试，摘要每次调用分别记账、取消仍禁止提交。确切源码/包 SHA、全套及三平台结果以本轮 READY.md 为准，尚未用户安装。

# 2026-10-08 Context 0.8.0-local.8：插件内兼容旧宿主

本轮只修 Context。原“宿主尚未支持提交前取消检查”由插件自己的提交事务替代：最后摘要/记账 await 后检查取消及原文选区，随后同步提交公开 Session 事件，保留工具配对与来源。profile 内独立恢复日志只保存两域的闲置/用量元数据；实际 Host 写成功才清理，旧 Host 存储先关闭时保留已知用量，重开按前驱哈希幂等恢复，不重新调用模型、不迁移会话或学习库。没有 profile 路径且没有可靠排空接口的嵌入环境仍在调用前拒绝。

隔离旧 SDK 验证采用未修改的旧 Basic/Domain/JSON；200K 测试使用真实 `contextWindow=200000`，不是 1M 窗口的软阈值。确切计数、候选 SHA、失败反例和未验证项以 `coordination/2026-10-08/context-200k-capability/plugin-local/READY.md` 为准。源码根 lib 保留原字节；新生成件仅在隔离 stage/冻结源码和包内。用户另一台 Ubuntu 尚未安装验收；本轮不改 Host、日常 profile、MSE、Goal 上限或原生界面风格。

后续备份/迁移要同时保留 `context_manager_idle`、`context_manager_summaries` 及 `.context-manager-recovery`。日志锁属于单进程；不要对活跃 profile 启动第二个 Host。进程被强制终止之后才可能返回的供应商用量无法获知，保持未知，不以重发调用补账。

# 2026-10-08 local.7：只读状态 wire 修复（待隔离构建验收）

local.6 的实际冻结 codec 会剥离 inspector 的 Goal 停因与 idle 的压缩阶段；local.7 仅补齐 `GoalReadout` 完整有界 schema 和 `compactionPhase` 枚举，并添加从实际 `lib/typert.js` 编码入口执行 JSON 往返的回归测试。不改变压缩业务。旧包及失败证据保持，根 lib 未构建；构建、测试、打包与安装由协调者另行完成，旧版通过数不代表本次 codec 已验收。

# 2026-10-08 接收修订 local.4（待最终组合验收）

同一 native 实现已正式交接给 Codex，继续同一 mirror，无并行业务副本。r1/r2/r3 冻结及失败记录保留。新增整事务新输入/选模失效、物理流独占收尾、逐字段/迟到/重开/写失败记账、存储关停排空注册，以及缺必要宿主能力时收费前阻断。r2曾通过148/148与独立13+21+68+82，但更强探针发现宿主最后提交窗口及root存储抢先关闭；不把旧通过数称为local.4验收。宿主最小公共修复由协调者单写，组合结果和SHA以 verification/context-long-task-20261007/READY.md 为准。日常、根lib、旧包、MSE预算保持。

# CONTEXT-LONGTASK-20261007：可恢复格式修复与绝对工作历史软预算

候选 `0.8.0-local.6` 在隔离目录构建与回归（148/148，并发 1），针对 MSE 长任务现场：`checkpoint.ts` 先做可证明无损的白名单归一化（BOM/换行/单一 JSON 围栏），只有“数组字段误写为单个字符串”才允许至多一次有预算的格式修复——失败正文完整传送（不放得下直接拒绝）、修复结果必须与确定性包裹逐字段一致，缺字段/未知字段/重复键/损坏/截断/散文/数字/对象/嵌套结构一律拒绝；`policy.ts` 增加绝对软触发/软目标（默认关闭，旧配置行为不变），有效准入取百分比、硬上限与绝对预算的保守值并保留来源标签，闲置门槛不再超过有效准入；`summary-ledger.ts` 各分量独立幂等补记、取消后迟到用量可见、128 条归档不迁走未知用量 attempt；`engine.ts` 在每次最终 await 后复核取消、卸载两阶段排空、修复请求经宿主计量与真实窗口预算检查。上下文页显示有效预算来源、修复中状态与 Goal 停因（只读投影，不修改 Goal）。冻结协议、SHA 与限制见 `verification/context-long-task-20261007/READY.md`。以下为历史记录。

# MARKET-20261005：独立发行包与中英文安装说明

`0.7.0-local.2` 为包装修订：补齐中英文安装、停用、卸载与数据保留说明，明确完整验收依赖 Missher 定制 rc.2；Schemastery 改为宿主 peer，补充元数据和包边界检查，测试并发固定为 1。9 个运行文件与 `0.7.0-local.1` 冻结包逐字节相同，未重新构建或改变业务逻辑；旧版本资产保持。

本轮 macOS Intel、Node 25.6.0 的全新 HOME/DSH_HOME 隔离 profile 已实际安装最终 tgz：三个 Loader 入口 active、只读 inspect/idleStatus 及重复查询截面保持通过；Bundle 停用/启用后冷启动、真实卸载与重装通过，2 个测试会话文件及原 profile 配置哈希不变。包 16 文件与源码一致，2 项 peer/预设测试通过。宿主 Web 默认根 Basic 禁用并交由各会话预设处理，卸载恢复该默认配置，不能将它误判为卸载失败。115/115 和 20/20 属于 10 月 3 日历史功能验证，本轮没有重跑 UI 或真实模型。

本插件负责人可提交并推送独立仓库；Release 资产、市场投稿、共享宿主与日常安装仍由协调者单写。本轮不写日常 profile、不升级宿主，当前实际 Git 与发布状态见协调目录 `coordination/2026-10-05/marketplace/context.md`。证据：`verification/RESULTS-MARKET-20261005.json`。以下为历史记录。

# CONTEXT-ENHANCEMENT-20261003：可恢复闲置整理与可追溯摘要

候选 `0.7.0-local.1` 已完成：持久化闲置资格和尝试状态，重启只恢复未尝试计划；请求前先安全裁剪旧文本工具结果，再按需生成七字段检查点；摘要独立用量账本、来源原文分页追溯、当前截面增长估算和压缩触发原因。沿用 C 版原生单面板、现有设置和配置，不覆盖用户阈值。新消息、模型切换、停用及超时都会取消过期维护；未知的在途摘要不会自动重发计费。

隔离完整 SDK 为官方 rc.2 基础，加协调者冻结的 `selectMaintenanceRange` / `supportsProtectedSeqs` 公共扩展。缺失前者时闲置压缩在付费调用前明确跳过；缺失后者时跳过工具裁剪。新元数据域 `context_manager_idle`、`context_manager_summaries` 随 profile 一并备份；旧会话无需迁移，不冷扫或激活历史 Agent。

115/115 隔离测试、Host/Client 类型与构建通过；真实隔离 Loader 三项 active、只读 RPC 通过。受控 Web 验证深浅主题、1280/800/335px、原文分段返回、无发送区及图表等高；这不等于日常 Electron 或真实模型质量验收。根 lib 与历史包保持原样，交付使用冻结 release。源码与宿主公共能力交给协调者统一 Git 发布；日常仍按用户要求与 MSE 同批安装，本任务不写日常 profile。

范围限制：检查点格式校验不能证明语义无损；未知供应商用量显示未知；增量是宿主投影估算，缺锚点不伪造。自动重试尚不能完整重跑 `preStep` 的所有动态注入，保留系统/最新用户原文并提示通过现有工具核查计划与文件；动态预测阈值及 MSE 长期学习不纳入本版。

本轮证据：`verification/RESULTS-ENHANCEMENT-20261003.json` 与协调目录 `coordination/2026-10-03/context-enhancement/HANDOFF.md`。以下为历史记录。

# CONTEXT-WINDOW-20261001：完整容量条与等高卡片

候选 `0.6.0-local.2`：总容量跟随宿主窗口，用 M/K 展示；当前上下文改为全宽、常显 K 分类及剩余的一条组成条。分类保留原始估算，宿主占用高出的差额单列，余量按较大估值计算。同排占用变化、压缩前后与累计卡片等高。压缩引擎与设置不改。

沿用用户已授权的 Git 和本机更新，源码本会话单写，日常 profile 仍由协调者单写。隔离候选与本轮验收位于协调目录 `coordination/2026-10-01/context-window-refinement/`；最终状态以该目录回执为准，旧包和源码 lib 保留。

冻结包已通过 24 项相关回归、Host/Client 类型检查、15 文件包审计、实际 rc.2 冷启动与客户端字节核验；1200/800/335px 和深浅主题下分类 K 数常显、三张图表等高。验收入口为 `verification/RESULTS-WINDOW-20261001.json`；示例数据为隔离夹具，未调用真实模型。正式安装与 Git 状态分别见本轮协调目录的安装和发布回执。

# 当前交付：CONTEXT-V2-20261001

候选 `0.6.0-local.1` 将上下文展示层替换为选定的 C 版。顶部为 100% 组成，中间为占用柱状图、压缩比较与本会话累计，内容列表/正文置底；新增摘要来源分类与四组筛选。复用 DSH 原生主题和控件，不引入第三方研究代码；压缩控制与闲置调度继续使用本插件既有控制器及官方 Basic 事务，不声称压缩后端从零重写。

源码仅改本插件。旧 lib、旧交付、其他插件与宿主保持；原配置、模块导出、三条 Loader 身份不变，没有额外兼容包。用户随后于 2026-10-01 明确授权发布 Git 和更新本机；Git 由本上下文会话单写，日常安装由协调会话单写，结果以协调目录 INSTALLATION_RECEIPT.md / PUBLISH_RECEIPT.md 为准。构建、实际 Loader 与浏览器验收位于协调目录 `coordination/2026-10-01/context-v2-release/`，源码测试以隔离候选执行。原生 Electron 和真实模型效果需按目标安装单列。

验收和安装入口见 `verification/RESULTS-V2-20261001.json`。下面记录为此前阶段，不代表本候选已安装到日常应用。

# 上下文管理插件

本轮命名与 UI 候选已在隔离目录构建并验证，确认日常依赖是冻结 tgz 后，将对应产物回填本目录已跟踪的 lib，避免新包名配到旧客户端注册。原 lib 已在协调目录备份；旧交付包保持字节不变。下面的「根 lib 保持」描述适用于当时的历史阶段。

2026-09-29 追加 UI-REFINE：当前 DSH 包名统一为 `@missher/dsh-context-manager`，配置和存储标识保留。此处为源码候选；本轮安装与验收以协调目录 `coordination/2026-09-29/ui-refinements/` 的回执为准，下面的版本与透明空格等描述保留为历史。

**2026-09-29 / UI-02、UI-06-context（当前）：**基于 0.4.0 保留全部闲置整理与请求前压缩功能，完成 0.5.0-local.1 本地升级包。官方峰谷改为原生价格/同等用量估算浮层；上下文单页增加公开投影重放的占用趋势、累计用量组成和逐次输入/输出变化。只写本插件，未改宿主或其他 Bundle；旧 lib 与旧包保持。53 项回归、Host/Client 类型、21 文件 lint、14 文件包边界、最终隔离 Loader 三项 active、RPC 和受控 Web 深浅主题/价格计算/草稿恢复/窄窗口检查均通过。最后标题栏留白 CSS 调整后已重建、做相关烟测并用最终包冷启动验证。交付位于 releases/dsh-context-manager-0.5.0-local.1（同名 tgz），证据 verification/RESULTS-UI-20260929.json。协调回执已写 coordination/2026-09-29/ui-implementation/context.md；协调者接手多插件组合验收，未写日常 profile，未进行 Git 发布、Electron 原生点击或真实供应商调用。以下为历史阶段记录。

**2026-09-29 / CONTEXT-IDLE-20260929（上一阶段）：**用户授权升级上下文插件并要求 DSH 原生设置风格。源码候选 0.4.0-local.1，针对 Harness 0.2.0-rc.1。增加任务正常完成后的闲置压缩，默认开启、15 分钟、最低 65%（至少高于软目标 10 个百分点），一次任务完成只尝试一次；新消息、停用和关闭会取消本插件维护。使用公开 compactNow / Agent maintenance 与 workspace activity 扩展点，不改宿主或其他 Bundle。设置改用原生 SettingsForm、SettingsValueField 与 Switch；上下文单面板增加轻量状态、摘要用量，原默认展开、只读输入区和官方峰谷提示保留。隔离构建目录为 verification/idle-20260929，根 lib 与旧交付不覆盖；安装目录 releases/dsh-context-manager-0.4.0-local.1。当前完成 Host/Client 类型、48 项测试、19 文件 lint、真实隔离 profile 升级/Loader/RPC 及 Web 原生设置保存验证；真实供应商与 Electron 窗口未验收，日常安装仍由协调者单一写入，不自行更改日常 profile，不 Git 写入。完整证据及状态见 verification/RESULTS-IDLE-20260929.json。下述较早阶段按日期保留。

**2026-09-29 / UPGRADE-20260929：**统一仓库源码已适配 Harness 0.2.0-rc.1，候选 0.3.6-local.1。现有业务接口、UI 和压缩逻辑无需修改；精确更新 DSH 版本声明，重新核验并生成预设元数据，修复开发脚本的旧 SDK 链接/React 类型发现。隔离构建、Host/Client 类型、34 项测试、插件 17 个源文件 lint、14 文件包边界均通过。实际 `dsh plugin add` tarball 安装后 3 个组件 active，inspector RPC 连读不改截面；卸载恢复原 5 行配置，重装后同一测试会话和自定义压缩参数仍保留。未修改生产 profile/旧源码/lib，未重启日常应用。实际 UI 因未认证根入口被浏览器拦截、正式认证入口仅被后台应用排队而未完成；不将组件测试当作原生验收。完整结果在 `verification/RESULTS-UPGRADE-020-20260929.json`，交付回执为协调目录 `coordination/2026-09-29/upgrade-020/context.md`。

- **REQ-03 实施轮（2026-09-28，当前）**：用户“全部完成”的新授权已启动开发，前两轮“只分类/未启动”为历史。源代码候选 `0.3.5-local.1` 仅将 `ContextInspectorView` 初始值及 target 切换重置改为展开；普通刷新仍尊重手动收起。新增覆盖首次、重开、换会话、主动/投影刷新、正文与列表分页、迟到正文取消的回归，保留发送区/草稿测试。构建与 Host/Client 类型检查在 `verification/req03-implementation/candidate` 完成，相关 12 项测试通过，旧 0.3.4 lib 负对照确实在默认展开断言失败。根 lib、旧包及日常 profile 保持原样；峰谷提示未迁移。候选路径、SHA 与验收分层见 `../coordination/2026-09-28/implementation/context-manager.md`；等待后续联调与 Git 明确命令。

- **本轮口径纠偏补充**：Ui-usage 指出 README 将失败重试一概排除在累计之外。已对照当前链接 SDK 的 token-meter 源码及 lib，确认本插件直接读 `tokenUsage`，有持久化有效用量的失败尝试/重试可以计入；逐次回复图的记录范围较小。仅修改 README、边界文档和回执，不修改实现或扩大测试，不重打包旧 0.3.4。

- **2026-09-28 协调审查（晚于 0.3.4 交付）**：源码 Git HEAD `c338afdcc41cb909219a8c70995a9d8379764174`，开始时工作树干净。本轮只审查与文档纠偏；REQ-03 外层详情默认展开已登记、未实施，源码初始与切换会话后的 `expanded=false` 均保留。确认单会话累计与 Ui-usage 跨会话聚合分工，官方峰谷提示为本插件保留的已授权例外。只读现查日常 profile 已引用独立 0.3.4，而非上轮记录的 0.3.3。在临时隔离副本运行 settings / inspector 两个已有测试文件，11/11 通过；复制的包审计脚本检查原 0.3.4 tarball，14 文件边界通过；未构建原 lib、未安装或重启应用。独占回执见 `../coordination/2026-09-28/context-manager.md`。本轮不进行任何 Git 发布操作，所有新功能等待明确命令；下列交付验收属于历史证据。

- **0.3.4 交付时验证（2026-09-28，早于本轮审查）**：根 src/lib/package 为权威源码，安装选 `releases/dsh-context-manager-0.3.4/`。用户明确峰谷提示仅跟随是否选择官方模型，和上下文百分比无关。提示移到模型旁 `conversation.input.right`，共享原生模型目录的已接受选择（含新会话默认值），不用发送消息或等待用量数据；非官方模型隐藏。10 项相关测试、host/client 类型检查、14 文件包边界审计、真实桌面 ASAR 隔离目录安装及三个组件 active 均通过。全新浏览器页验证空白会话显示、非官方隐藏、切回官方立即显示，浏览器 error 日志为 0；未发送消息或调用模型。冷启动发现并修复 `remote.session` 调用者依赖漏声明，首个候选及失败日志保存在 `verification/first-candidate-0.3.4/`。7 个后台 lib 文件与 0.3.3 完全相同。结果见 `verification/RESULTS-0.3.4.md` / `.json`；当时预览 60334，日常安装为独立 0.3.3。此次交付未改日常 profile 或重启应用，原生 Electron 窗口未点击验收。以下旧状态按时间保留。

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
