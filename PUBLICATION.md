# Context 0.10.0-local.4：额度阻断后的明确恢复入口

同批历史的旧摘要调用用完自动额度后，延长时限并不会返还额度。此前恢复按钮也被上限拦住，重启还可能丢失说明。本版让阻断状态跨重启可见，区分“本次未调用模型”和“旧调用用量未知”，并显示当前设置与每次压缩实际采用的时限。

## 安装和使用

从 [本版下载](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/tag/v0.10.0-local.4) 获取 `missher-dsh-context-manager-0.10.0-local.4.tgz`，在 DSH 插件管理中更新。等任务结束、完整备份后正常退出并重开 DSH。原设置保留：已经使用按进展等待的设备无需重设；仍选择固定时限的设备可在设置里自行切换并保存。Git 同步不会替另一台电脑修改设置。

对于额度用完的会话，进入“上下文”，先点“预检一次人工急救（不调用模型）”，查看模型、输入估算、时限及旧费用未知提示，再决定是否确认。这是两次明确操作；查看页面和预检都不发起模型请求。每批历史最多额外一次摘要调用，失败、取消或重启都不能重新领取，也不附带重试、格式修复或图片卸载恢复。旧自动额度与费用记录保留。

预检两分钟后、原文/模型/配置/工具变化后需重新预检。所有持久化等待结束后，模型请求前仍重新核验期限与绑定。当前进程仍有未结束摘要传输时拒绝并发。预检只整理恢复条件，成功急救只完成压缩维护；已结束的业务任务需要用户继续，不自动重放已完成操作。

## 验证范围

- 最终 r3 相关源码回归：89 项，88 通过、1 个仅 Electron 场景在普通 Node 跳过；实际 Electron 与生产 SDK 专项 6/6 通过。r2 的全量 341/2 skip 只属于旧候选，不冒充本版全量。
- 最终包对应实际 Electron Node24.18.1：116 个关键用例中 115 通过、1 个需要显式 ASAR 测试路径的场景跳过；该 ASAR 专项另有真实 Electron 3/3 验证，源码与运行件未改。
- 实际隔离 Host：正式 settings/mutate 保存及 reconcile、已有/新会话策略、重启回读、冷会话 lookup 与原 preset 恢复、只读查看不加载 Agent、人工预检不消费调用额度均通过。合成历史与旧账保留，零模型和外部网络请求。标准 Host 冷加载会追加一条 session/end-seed 元事件，已用独立公共 lookup 对照；所有既有事件逐项保持，已加载后的预检无事件增量。
- 旧候选的授权期限跨耐久等待、公共图片恢复钩子均有失败反例；后续真实 Host 发现的 ASAR 虚拟时间误判和冷会话依赖缺失也已修复。最终包通过，旧包未发布。

以上分组有重叠，不相加。真实供应商摘要质量、付费急救、原生点击和远端设备尚未验收。整组加载和发布不代表其他电脑已经更新。本版不改桌面本体、不增加平台专用分叉。

## 精确文件与回退

原包 SHA256：`604c1bae692640944ce5e071bc74722e309991f9b946c660854b11d6e321fa80`。89 个清单源文件、16 个生成件、23 个包成员已核对；原 tarball 不重打包，公开文档覆盖与精确映射见 [GIT_DELIVERY.json](./GIT_DELIVERY.json)。同提交的既有 12 项存储 CI 必须全部通过才发布。

备份需保留完整会话、学习记录、Context 原文档案/recovery 及所有存储域，包括新增 `context_manager_emergency`（单次消费 calls 和执行记录 runs）。降级也保留这个新域和最新旧账，不能用历史 profile 覆盖新用户数据、清除未知费用或返还已消费名额。

## 历史：local.3

# Context 0.10.0-local.3：长任务压缩后继续执行

本版修复默认固定 90 秒使持续生成摘要的长任务被中断的使用路径。新安装采用按输出进展等待；已有配置不猜测来源、不静默覆盖，顶部提供明确切换和原生保存入口。沿用现有 Basic / AgentLoop 公开协议：同一回合内成功压缩后继续下一步，已完成工具不重放。紧凑上下文页面、历史、费用和取消保护保持。

## 安装与启用

从 [本版下载](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/tag/v0.10.0-local.3) 获取 `missher-dsh-context-manager-0.10.0-local.3.tgz`，在 DSH 插件管理中更新。先等待任务结束并备份 profile、会话、学习数据和所有 Context 账本/原文档案，然后正常退出重开。

已有安装还需进入“设置 → 上下文管理”，点击“切换为按进展等待”，确认整事务 600000ms、首输出 120000ms、停滞 180000ms 后保存。原 `timeoutMs` 保留，模型和其他预算不变。多台电脑各自保存配置；下载或 Git 同步不会修改另一台电脑的设置。无需额外兼容插件或专用桌面包。

## 精确包与验证

原包保持冻结字节，不因公开文档更新而重新打包：

```text
ee89235c016b76f6fac653fc8096ebd012a46aa314ea2b9f0b55d3700e48a50d  missher-dsh-context-manager-0.10.0-local.3.tgz
```

87 清单源文件、16 运行件和 23 包成员已逐项核对；仓库既有 CI/历史文件保留。本版源码与文档覆盖映射见 [GIT_DELIVERY.json](./GIT_DELIVERY.json)。

- 增强 SDK：318 通过、2 个旧 SDK 场景跳过；最终专项 7/7。
- 当前桌面提取 SDK、Node 25：87 通过、2 跳过。
- 实际 Electron Node 24.18.1：59 个 AgentLoop/配置/恢复测试和 11 个 deadline 测试通过。设置组件测试因打包 SDK 不含 Button.tsx 开发源码而无法加载，未计作通过；组件由增强 SDK 单列验证，实际设置另由 Host RPC 验证。
- 实际隔离 Host：202 条 Loader、174 个启用项 active、11 客户端匹配；四字段 fixed→adaptive→fixed 保存回读，固定值及其他命名空间保持，运行 deadline 对应 600/120/180 秒。零模型/外部请求，正常排空。
- 长任务使用真实 AgentLoop、合成供应商及虚拟时间：工具只执行一次，摘要持续输出累计 300 秒后同回合继续；固定/总限/停滞反例停止且不继续业务、不暗中重试收费。不是物理等待 300 秒或真实模型验收。

各组重叠，不相加。正式发布需同提交既有 12 项存储 CI 全部通过，见 [CI](https://github.com/Missher12/Missher-DSH-Context-Manager/actions/workflows/context-portability.yml)。原生点击、真实供应商摘要质量/等待体验、远端设备未验收；发布不等于用户机器已更新。

## 失败与回退

首输出、停滞与整事务硬总限依然生效。取消、新输入、切模型和关闭优先，禁止迟到摘要提交。每个来源最多两次主摘要、四次总调用；未知或物理未结束调用不因重启或普通“继续”自动再次收费。已结束回合不从历史自动复活，手动 `/compact` 只执行维护。

降级前停止任务并关闭自动/闲置压缩，保留升级后的会话、`context_manager_operations`、cycles、idle、summaries、恢复日志和原文档案。不得拿旧备份覆盖新增数据，也不能忽略新调用账本后继续自动收费。

## English

New installs default to progress-based timing; existing fixed choices and values remain intact until explicitly saved otherwise. Native AgentLoop continuation resumes the current turn after successful compaction without replaying completed tools. Tested with exact frozen runtime bytes, synthetic long-output/cancellation/cost safeguards and real packaged Host settings round trips. Real providers, remote devices and native clicks are not validated here. Preserve all current ledgers and data when downgrading.

---

## 历史：local.2

# Context 0.10.0-local.2：自动压缩恢复与紧凑界面

本版同时交付自动压缩修复和紧凑上下文界面。普通任务按阈值自动整理；已经证实结束且没有应用的失败，可在同源预算内有限恢复。未知或中断调用继续保留记录，不能靠重启、换请求标识或重复点击自动再次收费。

模型名紧随当前上下文标题，请求和缓存命中用普通数值展示。三张短卡显示占用变化、最近被替换片段和本会话累计；下方默认两条压缩记录、三条有效内容，全部记录、正文、来源和用量细节仍可展开。未知用量保持未知，部分统计显示已知下界。

## 下载和安装本版

从 [v0.10.0-local.2](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/tag/v0.10.0-local.2) 下载 `missher-dsh-context-manager-0.10.0-local.2.tgz` 和校验文件，在 DSH 插件管理中更新已有插件，正常退出重开。无需另装兼容插件；公开仓库包含对应源码与运行件。GitHub 源码 ZIP 与插件 `.tgz` 用途不同。

升级前等待任务结束，备份 profile、会话、学习数据，以及 `context_manager_operations`、`context_manager_cycles`、`context_manager_idle`、`context_manager_summaries`、`.context-manager-recovery` 和 `.context-manager-archive`。升级不主动删除历史记录。

## 超时和恢复

- 已保存配置继续固定模式，原有 90 秒或自定义 `timeoutMs` 不变。需要允许持续生成较长摘要时，在上下文设置明确选择自适应：默认总限 600 秒、首个有效输出 120 秒、停滞 180 秒。只有非空正文或思考增量算进展，心跳和用量通知不算。
- 主摘要、重试、修复及最终提交共享总限；取消、新输入、模型变化或截止后拒绝迟到提交，已知迟到用量仍归原调用。
- 同源最多两次主摘要、四次总调用，手动与恢复也计入。仅确证结束且未应用的失败可以有限自动恢复。
- 历史未知调用需要满足来源、模型、有效期与剩余预算，才提供一次明确恢复授权；普通“继续”与重启不是收费授权。并非所有历史锁都有可用额度。
- 后台忙碌保留闲置资格、有界退避，不再因忙过 90 秒永久丢失资格，也不抢活跃任务。

## 精确包与验收

冻结 combined-ui-r5 原包没有因公开文档修改而重打包：

```text
d85c34c77743ae5400869c8ecae837716bc890891eb4e5d4738c6e30106e8a7c  missher-dsh-context-manager-0.10.0-local.2.tgz
```

104 源文件、23 包成员已核对；最终 client SHA256 为 `f43ec5d7ccf22352317534c6e90a95acad359afe847ac28d30f2a0ea8f5a9b25`。公开 README/发布记录已更新阶段说明，包内候选文档保持冻结时内容，以本页为准；逐文件对应关系见 [GIT_DELIVERY.json](./GIT_DELIVERY.json)。不公开私有参考图、会话标签、凭据和安装备份。

| 检查 | 结果 |
| --- | --- |
| 完整增强 SDK | 315 项：313 通过、2 个旧 Host 场景跳过 |
| 实际桌面打包运行时 | 10 文件、144 项，最终 142 通过、2 个旧 Host 场景跳过；两项测试输出目录错误修正后，所属 loop 文件 54/54 通过 |
| 实际隔离 Host | 202 Loader/174 启用 active、11 客户端匹配，固定→自适应→固定保存回读，原 90 秒保持 |
| RPC 语义 | 3 合成会话、8 当前/历史样本、377 断言通过，读取不改会话字节，模型/外网请求为零且正常排空 |
| 最终组件视觉 | 实现者验证精确 client + 原生控件/主题，七状态深浅色、1280/480/335 宽度、短窗及键盘展开 |
| 旧 SDK | 可移植专项 7/7；先前同后台字节全量仍有 54 失败/6 取消，不能称全面兼容 |
| 原生存储 CI | 沿用既有恢复日志/原文档案平台矩阵；正式发布要求本提交全部作业通过，见 [CI](https://github.com/Missher12/Missher-DSH-Context-Manager/actions/workflows/context-portability.yml) |

各集合重叠，不能相加。详见 [分层验证](./verification/RESULTS-AUTO-COMPACT-20261009.json)。真实 Host 页面被浏览器工具以 `ERR_BLOCKED_BY_CLIENT` 拦截，原生视觉/点击未新增验收；组件截图、Loader/RPC 不替代该层。真实供应商摘要质量、费用收益、远端设备和全部旧 Host 兼容仍未验收。

## 回退保护

旧版不读取新 operations 调用许可域。回退前必须关闭自动和闲置压缩、停止在途任务并保留最新会话和全部账本/恢复日志。不能只降级插件后继续自动运行，也不能用旧备份覆盖升级后新增的数据。回退应采用针对当前状态的配套流程。

## English: current release

This prerelease combines bounded automatic-compaction recovery and the approved compact inspector. Existing fixed timeouts stay unchanged; adaptive timing is an explicit choice. Meaningful text/reasoning progress extends the stall timer within one hard transaction limit. All manual, retry and recovery calls share the same two-primary/four-total budget. Unknown calls never silently dispatch again. Busy idle work retains eligibility.

The immutable r5 package matches the frozen product. Enhanced-SDK tests, focused actual packaged-runtime tests, real Host loading/settings and eight RPC semantic samples passed. Final-client component rendering was checked separately; actual-Host browser inspection was blocked, so native visuals, real-provider outcomes and remote machines remain unverified. Full legacy-SDK failures are retained. Disable automatic/idle compaction before downgrading and preserve the new operations domain with all current sessions and ledgers.

---

## Historical release: 0.10.0-local.1

长任务中的重复工具输出会占用上下文。本版增加工具文本精简、耐久原文档案和用量归因，沿用现有上下文页面与两个历史回读工具。Windows、Ubuntu、macOS 使用同一个插件包。

新增模式默认 **observe（观察）**，不改模型收到的工具文本；选择 **reduce** 后才精简新的、完整成功且符合明确规则的纯文本输出；**off** 关闭这项新功能。该开关只控制新工具精简，已有自动工作集压缩继续按原设置工作。原文先保存，Host 最终结果确认后才算发布成功。用量缺失显示未知或已知下界；字符减少不冒充 Token 或费用节省。分叉会话只可回读真实继承范围内的原文。

## 下载、安装与数据保留

1. 从 [v0.10.0-local.1 预发布](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/tag/v0.10.0-local.1) 下载 `missher-dsh-context-manager-0.10.0-local.1.tgz` 和 `SHA256SUMS`。
2. 等运行任务结束，备份 profile、会话、学习数据，以及 `.context-manager-recovery`、`.context-manager-archive`、`context_manager_idle`、`context_manager_summaries`、`context_manager_cycles`。
3. 在 DSH 插件管理中更新已有 `@missher/dsh-context-manager`，选择下载的包，无需另装兼容包。
4. 正常退出重开，确认版本及三个 Context 条目均正常。先使用 observe，需要实际精简时再选 reduce。

原文 blob 默认配额 **512 MiB**，包含失败遗留；三份索引清单各自有 **64 MiB** 和行数上限。512 MiB 不是目录总上限。超限或写入不可靠时保留 Host 原文，不发布悬空引用。档案没有自动到期删除，卸载也不删除原文；回退时保留更新后新增的会话和档案，不要覆盖回整份旧数据。本次为 Git 与包交付，未安装或重启日常 DSH。

## 精确包与验证

使用 Native 最终 r2 原包，未因修改公开说明重新打包：

```text
32d87ca6c961c75e516003acf32065bf7500a9da0d549190ef15e3a863ef7b95  missher-dsh-context-manager-0.10.0-local.1.tgz
```

23 个成员、16 个运行文件与冻结源匹配。公开中英文 README 另行校正两处阶段说明，原包内文档保持；两份公开说明的差异与 SHA 单列记录，其余 92 个冻结产品文件未改。逐文件绑定见 [GIT_DELIVERY.json](./GIT_DELIVERY.json)，分层结果见 [验证记录](./verification/RESULTS-EFFICIENCY-20261009.json)。

| 验证层 | 结果与范围 |
| --- | --- |
| r1 增强 SDK 全量 | 279 通过、2 个仅旧能力场景跳过；跳过项已在旧 SDK 执行通过 |
| r2 受影响检查 | locales/client 仅一处文案变化；设置和传输协议 29/29，其余 92 文件相同，不称 r2 重跑全量 |
| r2 独立复建 | 两项类型、构建、包边界通过；16 运行文件逐字节一致 |
| 独立逻辑/存储 | 核心13、归因8、归档故障3、生命周期3通过；普通/真实分叉存储恢复通过，绑定未变化模块 |
| 实际隔离 Host | Loader3/3、客户端、RPC语义8/8、引用身份6/6；reduce 保存后新进程仍保留，再恢复observe；两次正常退出，模型/外网尝试为零 |
| 原生磁盘 CI | archive/recovery 各自三平台×Node22/24；发布要求同候选12个job全绿，具体执行见 [CI](https://github.com/Missher12/Missher-DSH-Context-Manager/actions/workflows/context-portability.yml) |

archive CI 要求故障真正命中，检查重开、原文配额，并单独记录清单和总物理字节；不证明整个目录共用一个总配额。首轮 Windows 自动转换 CRLF，哈希门禁在故障测试前拒绝执行；已固定 LF，保留失败，未放宽校验或跳过 Windows。

旧 SDK 历史48项、新适配28项、额外七文件80项通过，这些集合有交叉，不能相加。额外全量仍有 **46失败/6取消**，含idle子集仍有 **4失败**；失败与保护断言保留，不称所有旧Host全面兼容。

## 尚未验收

- CUA 对真实本地页面返回 `ERR_BLOCKED_BY_CLIENT`：深浅主题、窄短窗口、提示及原生点击等视觉未通过。DOM、Loader、RPC不能替代视觉。
- 真实供应商摘要保真、净Token/费用收益、远端Qwen长任务未测，不承诺节省比例或解决所有压缩失败。
- 未新增普通市场安装、所有官方Host或Windows/Ubuntu完整桌面验收；未修复远端已有坏日志，未安装本轮日常版本。

## English

This prerelease adds verified tool-result reduction, durable originals and usage attribution. The new mode defaults to observe; reduce changes only new completed, recognized plain-text results. Existing automatic compaction keeps its settings. Original blobs have a 512 MiB quota; each of three manifests has a separate 64 MiB limit. Uninstalling does not delete the archive.

The immutable r2 package matches all 23 frozen members. r1 full regression and r2 targeted checks are reported separately. Release requires both six-job native-filesystem matrices to pass. Isolated Host and cold-restart checks passed; visual inspection was blocked by ERR_BLOCKED_BY_CLIENT. Real-provider savings, remote Qwen tasks, complete legacy-Host compatibility and daily installation remain unverified. Extra legacy failures are retained.
