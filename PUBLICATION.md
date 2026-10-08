# Context 0.10.0-local.1：工具结果精简与原文回读

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

23 个成员、16 个运行文件与冻结源匹配。逐文件绑定见 [GIT_DELIVERY.json](./GIT_DELIVERY.json)，分层结果见 [验证记录](./verification/RESULTS-EFFICIENCY-20261009.json)。

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
