# MARKET-20261005 当前交付边界

`0.7.0-local.2` 是中英文文档、依赖声明和发行元数据修订；9 个运行文件沿用冻结 local.1，不修改功能或日常安装。独立仓库是唯一源码，本插件负责人可提交推送；GitHub Release、市场 PR、宿主与日常 profile 由协调者单写。验证并发最多 1，冷安装与卸载重装仅使用独立 HOME/DSH_HOME；完整验证层级见 PROJECT_CONTEXT.md 顶部及 verification/RESULTS-MARKET-20261005.json。下方版本和发布等待状态为历史。

# 当前维护入口

2026-10-03：此独立仓库是本插件唯一后续源码入口，包含 Git 安装所需 lib。旧统一仓库副本停止维护。常规验证、职责与私有边界继续遵循下方规则；历史路径和发布等待状态不覆盖本次迁移。

# 上下文管理插件的修改边界

2026-10-03 当前候选为 `0.7.0-local.1`。本轮插件源码由本会话单写，公共宿主、Git 整合与日常安装由协调会话「推送项目到 Git」单写；安装继续与 MSE 同批。根 lib 与旧包保持，使用隔离构建/冻结 release，验收与限制见 PROJECT_CONTEXT.md 顶部和本轮回执。下方此前版本与 Git 分工均为历史。

当前版本为 2026-10-01 的 C 版图表界面。用户已授权发布 Git 和更新本机；本会话负责插件源码 Git，日常安装仍由协调会话单写，顺序、数据口径和回执入口见 PROJECT_CONTEXT.md。图表使用真实会话估算，不把演示数据或压缩释放量算进当前组成。以下按日期保留历史阶段。

**2026-09-29 / UI-02、UI-06-context（当前）：**基于 0.4.0 保留全部闲置整理与请求前压缩功能，完成 0.5.0-local.1 本地升级包。官方峰谷改为原生价格/同等用量估算浮层；上下文单页增加公开投影重放的占用趋势、累计用量组成和逐次输入/输出变化。只写本插件，未改宿主或其他 Bundle；旧 lib 与旧包保持。53 项回归、Host/Client 类型、21 文件 lint、14 文件包边界、最终隔离 Loader 三项 active、RPC 和受控 Web 深浅主题/价格计算/草稿恢复/窄窗口检查均通过。最后标题栏留白 CSS 调整后已重建、做相关烟测并用最终包冷启动验证。交付位于 releases/dsh-context-manager-0.5.0-local.1（同名 tgz），证据 verification/RESULTS-UI-20260929.json。协调回执已写 coordination/2026-09-29/ui-implementation/context.md；协调者接手多插件组合验收，未写日常 profile，未进行 Git 发布、Electron 原生点击或真实供应商调用。以下为历史阶段记录。

**2026-09-29 / CONTEXT-IDLE-20260929（上一阶段）：**用户授权升级上下文插件并要求 DSH 原生设置风格。源码候选 0.4.0-local.1，针对 Harness 0.2.0-rc.1。增加任务正常完成后的闲置压缩，默认开启、15 分钟、最低 65%（至少高于软目标 10 个百分点），一次任务完成只尝试一次；新消息、停用和关闭会取消本插件维护。使用公开 compactNow / Agent maintenance 与 workspace activity 扩展点，不改宿主或其他 Bundle。设置改用原生 SettingsForm、SettingsValueField 与 Switch；上下文单面板增加轻量状态、摘要用量，原默认展开、只读输入区和官方峰谷提示保留。隔离构建目录为 verification/idle-20260929，根 lib 与旧交付不覆盖；安装目录 releases/dsh-context-manager-0.4.0-local.1。当前完成 Host/Client 类型、48 项测试、19 文件 lint、真实隔离 profile 升级/Loader/RPC 及 Web 原生设置保存验证；真实供应商与 Electron 窗口未验收，日常安装仍由协调者单一写入，不自行更改日常 profile，不 Git 写入。完整证据及状态见 verification/RESULTS-IDLE-20260929.json。下述较早阶段按日期保留。

**2026-09-29 当前维护阶段：**按 UPGRADE-20260929 适配 Harness 0.2.0-rc.1。唯一源码为统一仓库 `plugins/dsh-context-manager`，旧协调目录仅作历史，不回写。候选版本 0.3.6-local.1；业务源码保持，精确更新 11 个 DSH peer、开发声明与预设基线。SDK 为协调者提供的只读已构建候选；本插件独立依赖用 `scripts/link-harness.mjs` 接入，包含 React 类型。构建/测试/安装均在 `verification/upgrade-020-20260929`，原 lib 和旧包不覆盖。真实临时 profile 的安装、卸载、重装、三个 Loader 条目与 inspector RPC 已通过；浏览器/原生/真实模型仍未验收。日常安装由协调者统一完成，本轮不 Git 发布；后续历史阶段说明不覆盖本条。

- 2026-09-28 最新实施授权以根 `IMPLEMENTATION_PLAN.md` 为准：本任务完成 REQ-03 及直接相关测试，允许修改本目录源码/测试/文档；构建和有写入验证只在隔离候选中进行。此前“只分类/未启动”属于历史阶段。峰谷提示暂不迁移；不写宿主或其他插件，不修改生产 profile 或重启日常应用，不进行任何 Git 发布操作。最终回执为 `../coordination/2026-09-28/implementation/context-manager.md`。
- 前两轮只分类与有界审查的回执保留为历史，当前实施安排已覆盖“暂不实施”限制；任何 Git 写操作仍等待用户明确命令。不改协调总表或上级 PROJECT_CONTEXT/HANDOVER。
- 当前源码候选为 `0.3.5-local.1`；已交付版本仍为 `releases/dsh-context-manager-0.3.4/`，本轮开始只读确认日常 profile 指向该独立 0.3.4 目录。根 lib 保留原字节，与新候选源码不同步，构建和联调使用 `verification/req03-implementation/` 内的隔离候选；已交付版本不原地覆盖。
- REQ-03 已实现：`ContextInspectorView` 初始和切换 target 时展开，重新挂载同样展开；普通刷新不重置用户手动收起。正文只读取选中条目的当前分页，保留取消旧请求及只读/草稿恢复。只修改两个展开默认值，避免另造状态机。
- 当前会话截面、逐次回复与本会话累计用量属于本插件；Ui-usage 负责跨会话聚合及独立派生缓存。两者不相互依赖、不互相搬迁累计区。官方峰谷提示产品逻辑已按 RC-01 归模型域，现有实现仍由本插件单一保管；本轮不迁移、不删除该功能。
- 用户最新要求：“上下文”只显示少量关键数据、紧凑布局，不显示发送区；详细内容在同一页展开，不加内部页签。峰谷提示的显示条件仅是选中官方 DeepSeek 模型，与上下文百分比、历史记录、是否发送过消息无关。提示位于模型选择器旁的 `conversation.input.right`，新会话默认官方模型也要显示；切到非官方模型即隐藏。
- 峰谷提示共享原生 `modelDirectories.directoryFor(sessionId).store.current`，跟随模型选择器已接受的选择，不另外发 RPC。Cordis 的服务方法按调用者上下文检查依赖，必须同时声明 `modelDirectories`、`sessions`、`remote`、`remote.session`；仅声明根 `remote` 会在新目录首次创建时报错。需验收新会话、切换模型与冷启动浏览器日志。
- `readonly-view.ts` 仅在当前上下文视图挂载期间隐藏其祖先会话的常驻 composer seat；切走恢复原 display/hidden/inert，保留草稿，不全局匹配或改公共样式。布局标记变化需重新验收。


- 本目录是独立的 `dsh-context-manager` Bundle。职责是请求前压缩、压缩设置和只读上下文详情。用户于 2026-09-27 明确位置：在原有“对话 / 轨迹”同一排的“轨迹”后增加“上下文”视图；设置页只保留压缩参数。此要求取代此前设置页入口及输入框摘要加侧栏方案。正式入口使用 `conversation.view`，上下文数据不另加 composer dock 或右侧面板；用户新授权的官方峰谷提示使用 `conversation.input.right`。用户后续已授权正式实现；0.3.0 接入真实只读数据，0.2.1 安装包仍保持原字节。
- 先读 `PROJECT_CONTEXT.md` 和 `PLUGIN_BOUNDARIES.md`，保留已交付 tarball 的内容与 SHA。文档或验收补充不覆盖已经给用户的同版本安装包。
- Session Bridge 由任务 `01a0e136-a8b3-7cb1-b322-aa0813ec29d9` 单独维护。可以只读核验，不直接修改、构建、打包或发布其源码、lib、manifest、配置及文档；跨插件修复先交接给其负责人。
- 本插件不能依赖、内嵌、安装或代为修复 Session Bridge；不得增加对方样式选择器、清理器、服务或跨会话工具。使用 DSH 官方 Session/Projection/Compaction 接口是本插件职责，不等于依赖 Session Bridge。
- CSS 限于 `.dsh-context-settings`，所有 style 节点显式带 `data-plugin="dsh-context-manager"`；清理仅归属自己的节点，不扫描或删除页面其他样式。
- 宿主 `client-modules` 的通用修复必须是单独的上游改动，不藏入本插件安装包。日常 profile 与正在运行的应用继续遵循用户明确约束。
- 按影响验证。交付包执行 `node scripts/verify-package-boundary.mjs /absolute/path/package.tgz`；两插件共存/热更新证据与原生点击验收分开报告。`verification/` 的 Bridge 快照仅为历史证据，禁止当作当前 Bridge 交付。
