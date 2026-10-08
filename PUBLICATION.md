# Context 0.9.0-local.2：修复闲置压缩导致的历史重载失败

旧版可能在任务回合已经结束后裁剪工具结果，写出回合之外的替换事件，使 V4 严格日志重载拒绝该会话。摘要成功和摘要失败都可能触发。本版仅在真实日志仍有开放回合时调用工具裁剪器；闲置和手动压缩继续生成合法摘要，任务执行中的裁剪及保护保持。

没有放宽日志校验、伪造回合或修改 Host、MSE、Goal、模型与预算。十二个运行文件相对 local.1 **只改变 engine.js**。自动工作集、原文回查和此前 Windows 恢复日志修复继续保留，各平台共用同一个包。

## 下载与安装

1. 下载 [0.9.0-local.2 通用安装包](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.9.0-local.2/missher-dsh-context-manager-0.9.0-local.2.tgz)，对照 [SHA256SUMS](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.9.0-local.2/SHA256SUMS)。大小 193799 bytes，SHA256：`a924d50e95018e6cb65da0d511819830f5f36a06bf11da3591a54dcd07bea6b9`。
2. 等当前任务结束，完整备份 profile、会话及插件数据。Context 需保留 `.context-manager-recovery` 和 `context_manager_idle`、`context_manager_summaries`、`context_manager_cycles` 三个域。
3. 在 **插件 → 添加插件** 中更新现有 `@missher/dsh-context-manager`，选择包或填写上述 URL，无需另装兼容插件或编译。
4. 完整退出并重开 DSH，确认版本和 `context-manager`、`context-manager-engine`、`context-manager-inspector` 正常加载。

**此更新防止继续生成该类事件，不会自动修复已有坏日志。** 保留受损原件、完整备份，在副本上单独验证恢复；不要通过删除会话或恢复日志排错。本机日志通过检查，不能替代另一台电脑的受损样本。

## 验证范围

| 层级 | 结果 |
| --- | --- |
| 增强 SDK 构建和 Host/Client 类型 | 通过 |
| 完整增强 SDK | 242 项：240 通过、0 失败、2 旧能力缺失场景另测 |
| 自然旧 SDK 构建、类型与专项 | 48/48，无跳过 |
| 缺陷与相邻保护定向回归 | 负责人及协调者独立各 10/10 |
| 源码和包绑定 | 141 源文件、19 包成员、12 运行文件核对一致 |
| 当前桌面整组隔离加载 | 174 启用项 active，11 客户端匹配，正常 IPC 关闭 |
| 本机 Intel Mac 实际安装 | 175 启用项 active、11 客户端匹配、55 会话及 26 学习/160 事件保留 |

新回归包含手动摘要成功、畸形失败、取消、继承历史、自动闲置，以及开放回合内真实裁剪和错误／富媒体保护。使用实际 V4 编码、完整 Zstandard 落盘校验、严格 codec 和 Session.fromRestore；不会通过守卫短路伪造裁剪覆盖。没有真实模型或嵌入调用。这不是完整后端 resumeAgent、真实供应商摘要质量或另一台 Windows/Ubuntu 的原生桌面验收。

本机此前完整多帧扫描共 55 日志、48,144 事件及 27 次合法裁剪，独立 zstd 检查字节和事件数量；安装前再次确认全部日志 SHA 未变。首次仅扫描首帧的旧结果已明确撤回，没有将无效扫描算作通过。其他设备的受损日志不在这台 Mac，未自动改写。

本机使用下方正式包完成安装并启动，19 个包文件回读一致；完整新鲜备份后 584 个受保护文件启动前一致。App 和其他插件保持，会话、凭据、三个 Context 域在启动后也逐字节保持；MSE 只变动既有运行计划的定时字段，内容与费用不变。首次检查早于后台 Host 就绪，等待实际 Host 后复查通过，没有重复安装或回滚。

正式包只将冻结候选的中英文 README 与兼容说明更新为公开安装口径，其余 16 文件逐字节一致。冻结行为包 SHA 为 `446ff04dd1f1811fc15302694cbe42c5b426ca48165d5ee0ea169ab5fc0b2e45`；旧归档与原反例保持。精确绑定见 [GIT_DELIVERY.json](./GIT_DELIVERY.json)，安装和分层结果见 [验证记录](./verification/RESULTS-IDLE-PRUNE-20261008.json)。

## English

This prerelease fixes idle/manual compaction writing a tool-result replacement outside a turn, which can make the strict V4 reader reject history. The pruning API now requires a real open turn in the log. Valid maintenance summaries and protected in-turn pruning remain available; only engine.js changes among the twelve runtime files.

Use the shared package, back up all Context domains and the recovery journal, update the existing plugin and fully restart. This prevents new occurrences; it does not repair an already damaged log. Keep the original and validate recovery separately on a copy. Independent regression passed 10/10 with actual physical codecs and Session restoration. Enhanced SDK passed 240 with two old-only skips, and natural old SDK passed 48/48. Remote-device Desktop behavior and real-model quality remain separate acceptance layers.
