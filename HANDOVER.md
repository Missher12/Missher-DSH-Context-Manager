# CONTEXT-WINDOW-20261001：完整容量条与等高卡片

候选 `0.6.0-local.2`：总容量跟随宿主窗口，用 M/K 展示；当前上下文改为全宽、常显 K 分类及剩余的一条组成条。分类保留原始估算，宿主占用高出的差额单列，余量按较大估值计算。同排占用变化、压缩前后与累计卡片等高。压缩引擎与设置不改。

沿用用户已授权的 Git 和本机更新，源码本会话单写，日常 profile 仍由协调者单写。隔离候选与本轮验收位于协调目录 `coordination/2026-10-01/context-window-refinement/`；最终状态以该目录回执为准，旧包和源码 lib 保留。

冻结包已通过 24 项相关回归、Host/Client 类型检查、15 文件包审计、实际 rc.2 冷启动与客户端字节核验；1200/800/335px 和深浅主题下分类 K 数常显、三张图表等高。验收入口为 `verification/RESULTS-WINDOW-20261001.json`；示例数据为隔离夹具，未调用真实模型。正式安装与 Git 状态分别见本轮协调目录的安装和发布回执。

# 当前交付：CONTEXT-V2-20261001

候选 `0.6.0-local.1` 将上下文展示层替换为选定的 C 版。顶部为 100% 组成，中间为占用柱状图、压缩比较与本会话累计，内容列表/正文置底；新增摘要来源分类与四组筛选。复用 DSH 原生主题和控件，不引入第三方研究代码；压缩控制与闲置调度继续使用本插件既有控制器及官方 Basic 事务，不声称压缩后端从零重写。

源码仅改本插件。旧 lib、旧交付、其他插件与宿主保持；原配置、模块导出、三条 Loader 身份不变，没有额外兼容包。用户随后于 2026-10-01 明确授权发布 Git 和更新本机；Git 由本上下文会话单写，日常安装由协调会话单写，结果以协调目录 INSTALLATION_RECEIPT.md / PUBLISH_RECEIPT.md 为准。构建、实际 Loader 与浏览器验收位于协调目录 `coordination/2026-10-01/context-v2-release/`，源码测试以隔离候选执行。原生 Electron 和真实模型效果需按目标安装单列。

验收和安装入口见 `verification/RESULTS-V2-20261001.json`。下面记录为此前阶段，不代表本候选已安装到日常应用。

# 当前交接入口 · 2026-09-28

**2026-09-29 / UI-02、UI-06-context（当前）：**基于 0.4.0 保留全部闲置整理与请求前压缩功能，完成 0.5.0-local.1 本地升级包。官方峰谷改为原生价格/同等用量估算浮层；上下文单页增加公开投影重放的占用趋势、累计用量组成和逐次输入/输出变化。只写本插件，未改宿主或其他 Bundle；旧 lib 与旧包保持。53 项回归、Host/Client 类型、21 文件 lint、14 文件包边界、最终隔离 Loader 三项 active、RPC 和受控 Web 深浅主题/价格计算/草稿恢复/窄窗口检查均通过。最后标题栏留白 CSS 调整后已重建、做相关烟测并用最终包冷启动验证。交付位于 releases/dsh-context-manager-0.5.0-local.1（同名 tgz），证据 verification/RESULTS-UI-20260929.json。协调回执已写 coordination/2026-09-29/ui-implementation/context.md；协调者接手多插件组合验收，未写日常 profile，未进行 Git 发布、Electron 原生点击或真实供应商调用。以下为历史阶段记录。

**2026-09-29 / CONTEXT-IDLE-20260929（上一阶段）：**用户授权升级上下文插件并要求 DSH 原生设置风格。源码候选 0.4.0-local.1，针对 Harness 0.2.0-rc.1。增加任务正常完成后的闲置压缩，默认开启、15 分钟、最低 65%（至少高于软目标 10 个百分点），一次任务完成只尝试一次；新消息、停用和关闭会取消本插件维护。使用公开 compactNow / Agent maintenance 与 workspace activity 扩展点，不改宿主或其他 Bundle。设置改用原生 SettingsForm、SettingsValueField 与 Switch；上下文单面板增加轻量状态、摘要用量，原默认展开、只读输入区和官方峰谷提示保留。隔离构建目录为 verification/idle-20260929，根 lib 与旧交付不覆盖；安装目录 releases/dsh-context-manager-0.4.0-local.1。当前完成 Host/Client 类型、48 项测试、19 文件 lint、真实隔离 profile 升级/Loader/RPC 及 Web 原生设置保存验证；真实供应商与 Electron 窗口未验收，日常安装仍由协调者单一写入，不自行更改日常 profile，不 Git 写入。完整证据及状态见 verification/RESULTS-IDLE-20260929.json。下述较早阶段按日期保留。

**最新交接（2026-09-29）：**Harness 0.2.0-rc.1 适配候选为 0.3.6-local.1，安装包与独立目录位于本插件 `verification/upgrade-020-20260929/`。34 项测试、类型/构建/lint、真实 Loader/RPC、安装/卸载/重装通过；3 个组件正常激活。业务源码保持原功能。日常安装及多插件 UI 由协调者统一审核；本轮浏览器/原生 UI/真实模型未验收，临时 Host 已退出。使用新统一源码入口，不回写旧插件目录；原 lib 保留。详见 `verification/RESULTS-UPGRADE-020-20260929.json` 与协调目录专属回执 `coordination/2026-09-29/upgrade-020/context.md`。

最新实施安排已启动 REQ-03。当前源码/manifest 为 `0.3.5-local.1` 候选，外层详情默认展开已完成；候选只在 `verification/req03-implementation/` 隔离构建，原 lib 和已交付 0.3.4 保留原字节，不能从根 lib 判断新源码行为。实施回执见 `../coordination/2026-09-28/implementation/context-manager.md`，后续联调据其中的候选路径和 SHA。下文分类审查的“仅登记/待开发”是更早阶段；本轮仍禁止 Git 写操作与生产部署。

本插件当前源码和交付版本为 0.3.4，Git 基线 `c338afdcc41cb909219a8c70995a9d8379764174`；日常 profile 本轮只读现查指向独立 0.3.4 发布目录。以下 0.3.1 / 0.2.1 内容全部保留为历史，不能据其中的根目录版本、旧 PID、预览端口或安装路径执行当前操作。

最新状态读本目录 `PROJECT_CONTEXT.md`，协调授权读上级 `PROJECT_GOVERNANCE.md`。本轮只做职责审查、文档纠偏和隔离回归，回执为 `../coordination/2026-09-28/context-manager.md`；未改业务代码、原 lib、生产配置或用户数据，未重启应用。REQ-03 外层详情默认展开仅登记待开发；官方峰谷提示保留为用户授权例外。本轮及后续 Git 操作均等待用户新的明确命令。

# 历史交付 0.3.1 · 2026-09-27

17:38 现场处理补充：用户已改装独立 0.3.1 目录并授权“你来解决”。旧桌面进程已退出，已启动真实日常应用（主 PID 8237 / host PID 8274），实际 profile 的四个插件模块只读导入通过，未改日常配置。驻留组件/原生 UI 尚不能验证：工具 native API 不可用，工具浏览器打开真实 host URL 被阻止，不绕过。证据 `verification/daily-restart-result-0.3.1.json`。不要再把安装错误说成装错版本，也不要将新进程误作 16:51 的旧进程。

安装目录 `releases/dsh-context-manager-0.3.1/`，完整源代码 `verification/work-0.3.1/`。根目录因用户日常 link 安装保持 0.3.0，不要直接覆盖/构建；下一轮先核验有效安装路径。

已捕获旧进程 exports 缓存导致 inspector 导入失败；完整重启后新版三个组件 active。所有上下文数据合为单面板，27 tests + 双端 typecheck + 实际 Desktop ASAR 运行时隔离 Web 验证通过。详见 `verification/RESULTS-0.3.1.md` 和 `DELIVERY-0.3.1.json`。新预览 60334 / 测试进程 PID 4728，旧 58550 预览继续保留。未操作用户日常 profile/应用。

# 上下文插件交接

更新时间：2026-09-27。用户已授权实现，明确只放设置页。

## 两任务的维护边界

用户明确要求与【DSH】Session-brigde 对齐、切割。已通过原生任务消息向 `01a0e136-a8b3-7cb1-b322-aa0813ec29d9` 交接桥接的样式归属修复，对方已明确接受文件和交付边界，并接管常规样式及独立卸载回归。本任务从此仅维护本目录，正式确认依据见 `PLUGIN_BOUNDARIES.md` / `verification/coordination-20260927.json`。

最终回执已收：Bridge 31 条测试和真实已装 ASAR/Cordis 的双向样式隔离回归通过；其包不含上下文实现或依赖。已只读核验对方 verification JSON；上下文安装包 SHA 再次确认未变。原生 UI、生产安装器和宿主重新打包仍未验收，不能把这次边界协调表述为完成这些事项。

新增 `AGENTS.md` 明确唯一写入者；`scripts/verify-package-boundary.mjs` 对已交付 0.2.1 tarball 做只读审计，确认不含 Bridge 代码、依赖、安装钩子、配置接管或验证快照。现有安装包 SHA 不变，未因文档和协作重复发布同版本。DSH 官方 Session/Projection/Compaction 服务仍是实现压缩所需的合法宿主依赖，不能误切掉。

最新交付仅为 `dsh-context-manager-0.2.1.tgz`，用户自行通过插件页安装，保持 DSH 原生设计。不要代为修改日常 profile。0.2.0 升级引发的会话标识错乱已定位为样式归属误删，并完成隔离修复及热卸载/重装验证。本机桥接源码同步样式标记后，并行工作的后续构建已带上修复；旧快照桥接 0.1.1 包只留在 verification 作证据，不能给用户安装覆盖当前桥接功能。

## 0.2.1 样式修复

- 已提取实际 Desktop app.asar 的 client-modules，用真实 Cordis Loader/Entry 复现桥接的未标记样式被认领为 dsh-context-manager；卸载/更新后 `position: absolute` 变成 `static`。
- 修复本插件的两处 React style 及桥接 effect style 的 data-plugin/data-plugin-css；不改任何 CSS 规则或 Host 引擎。桥接原项目仅同步 src/client/index.tsx 的最小修复，未重建受日常 HMR 监听的 lib。修复包在隔离副本构建，宿主 lib 字节不变。
- 13:25 本机桥接构建出现并行工作的 RPC/HTTP 改动，并已含样式标记。尝试写入已验证旧构建时 SHA 守卫正确拒绝，未覆盖任何新代码。现有 lib/client/index.js 及样式归属须以最新核验为准；最终交付不附带旧桥接包。
- 22 项本插件测试、30 项桥接测试、两边类型检查通过；实际 Desktop 加载器旧版失败/新版成功、升级/卸载/重装/桥接自身清理均验证。
- 官方 Web 隔离 profile 最终包安装、页面、插件管理器热卸载再安装通过；样式归属独立、按钮 22px、面板悬浮，最终模拟历史/概览读取成功，控制台 error 0。未操作日常 Desktop UI，不能声称用户当前窗口已恢复。
- 旧模拟 history 缺 system 首节点，严格持久化读取失败；已仅修复测试种子并增加 V4 编码解码校验。旧文件保留，新 v3 会话通过。详见 verification/RESULTS.md 和 style-ownership/。

## 已完成

- 源码、Host 调度、官方事务复用、同模型/推理摘要、设置页与版本固定的 Bundle overlay。
- 16 项测试与严格 TypeScript 检查通过，包括真实 AgentLoop、精确 79.9%、失败/取消、两会话隔离、实际路由切换、图像计价/原引用保留、工具增长、估算外溢出与回放。
- 临时 profile 的真实 Web 页面显示、修改、保存、刷新保留已核验。只使用测试配置，未配置/调用真实模型 API。
- 源码 link 安装和卸载完成；发布格式 tgz 已通过官方 CLI 的离线安装及真实 Web boot。最终包和验收记录在本目录及 verification。
- 0.1.1 已复用宿主控件与主题变量；以最终 tgz 安装到隔离 profile，验证浅色/深色、70%/40% 保存及刷新保留、恢复 80%/55%、滑块键盘同步和高级设置。截图保存在 verification；控制台错误 0，无横向溢出。再次 16/16 测试通过，未改压缩引擎。
- 0.1.1 临时 Web 服务已关闭，Bundle 已卸载，五项原始 compaction/preset 配置恢复、用户策略保留。旧 0.1.0 安装包及版本验收记录仍保留。
- 0.2.0 增加官方用量/组成、工具定义排行、最近请求与压缩记录的只读概览。22/22 测试、两个严格 TS 程序、最终 tgz 的真实 Web 深浅主题、会话选择、70/40 保存刷新及恢复 80/55、卸载恢复均完成。压缩引擎与 policy 的构建文件和 0.1.1 字节相同。新证据见 verification/RESULTS.md / DELIVERY.json。
- 0.2.0 SHA-256：ee1b8dbe3e0d6ca14beafc4641238441e2157aa97448944473825dd33dc02046，24,832 bytes。旧包保留。隔离服务/页签关闭，Bundle 卸载；临时夹具已移除，模拟会话日志保留。真实 API 调用仍为 0。

## 实现注意

- `llm/stream` 必须 yield 本地终止流；不能通过 throw 代替请求恢复入口。
- `agent/request-error` 以 prepend 接管本地码，防止 llm-retry 的 always 策略形成循环。
- `agentPresets.serviceFor(agent, 'compaction')` 才能找到 preset 隔离服务；agent.ctx.get 只作为根服务回退。
- 保护最新真实用户任务，以及本步骤收到的所有非 checkpoint 输入。巨大最近工具结果可与整个完成的工具组一起摘要。
- 提供方已确认溢出但估算未到目标时，仍要选择有用的大范围，不能仅挑一条短回复。首个失败证据保留在 verification/first-overflow-failure.log。
- 原始日志保持官方格式，未引入未知必须事件；跨重启专属一键恢复未实现，不能描述成已有。
- 开发依赖使用离线软链；分发包不包含软链或 node_modules。生成预设 overlay 依赖固定 upstream commit/hash，不适配所有版本或自定义 preset。

## 下一阶段

- 真实模型的长中文、图片、长推理、摘要质量与成本验收；原生 Intel Mac 安装/卸载。
- 后续可单独验证全文上下文浏览、六类组成及历史检索；当前概览是三类官方组成及有界记录。跨重启恢复仍需独立设计，不自动重放业务副作用。
- 发布其他平台或版本需要新的兼容矩阵，不改变用户当前日常 profile。不要改上级 MSE 工作区或交接文件。
