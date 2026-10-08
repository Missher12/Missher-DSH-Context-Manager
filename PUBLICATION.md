# 0.8.0-local.8：旧宿主的插件内适配

本版修复旧宿主在 200K 模型上拒绝压缩的问题：摘要提交前的取消检查、选区验证和待补记用量恢复由上下文插件自己承担。无需为了这些接口替换 Ubuntu 宿主，也不需要额外兼容插件。

## 下载与更新

下载 [local.8 安装包](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.8.0-local.8/missher-dsh-context-manager-0.8.0-local.8.tgz) 和 [SHA256SUMS](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.8.0-local.8/SHA256SUMS)。这是公开预发布版本；[发布页](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/tag/v0.8.0-local.8)说明验证范围。

1. 备份当前 profile 和会话数据，同时保留 `.context-manager-recovery`、`context_manager_idle`、`context_manager_summaries`。
2. 在 DSH 的 **插件 → 添加插件** 中选择下载的 `.tgz` 或粘贴下载地址，更新已有的 `@missher/dsh-context-manager`。
3. 按应用提示重新加载或正常退出后重启，确认插件版本为 `0.8.0-local.8`。不能只拉取 Git 就认为已安装。

恢复日志只记录允许的用量与闲置元数据，没有对话正文或模型任务队列。已收到的用量先持久保存，再写宿主数据域；重启按同一 attempt 恢复，不重发模型或重复累加。遇到日志损坏、状态冲突或独占锁不明会拒绝继续。进程退出前从未收到的供应商用量只能保持未知，不能凭空补全。

## 验证范围

| 验证 | 结果 |
| --- | --- |
| 增强 SDK 完整套件 | 181 项：179 通过、0 失败、2 项旧能力专属用例跳过 |
| 自然旧 SDK | 21/21 通过，两项旧能力用例实际执行，无修改宿主来模拟旧版 |
| 取消、输入变化、卸载及迟到用量生命周期 | 23 场景、242/242 检查 |
| 新输入、附件与受保护内容超限 | 3 场景、21/21 检查 |
| 旧 CLI 安装及两次冷 Host 启动 | 准备 3/3；两次各 27/27，三个插件入口 active，恢复目录权限与锁释放通过 |
| 发布包 | 16 个包成员与冻结源码一致；九个运行文件只有 engine/index 相比 local.7 改变 |

这些旧／新 SDK 检查在 Intel macOS 上使用合成供应商执行，没有真实模型请求。真实 `contextWindow=200000` 场景覆盖 8192/60000 输出预留；有最终 await 取消、域和 JSON 存储先关闭后用量到达，以及两次重开不重复记费的回归。上述检查存在重叠，不合并成一个测试总数。

尚未完成用户 Ubuntu 实机升级、Windows/Linux 原生插件完整流程、Electron 点击或真实模型的长期摘要质量验收。发布不会替用户机器安装，不修改 MSE、Goal 限额、学习库或宿主；没有 profile 路径的自定义嵌入仍需安全存储排空能力。

[机器可读结果](./verification/RESULTS-LOCAL8-20261008.json)区分负责人回归和发布者的独立核对。[运行文件清单](./GIT_DELIVERY.json)记录九个运行文件与冻结包的对应关系。

## 固定包与源码

安装包 SHA256：`b73fc64d735096f1071a79d10a2da73a57ade42b2ad491fca05f1643c0fc06ab`。

本发布保留已验收 tgz 的原始字节。包内 README 是冻结时的开发快照；当前安装与发布状态以本页和仓库中英文 README 为准。本 Git 导出包含新版运行文件；维护电脑 canonical 目录保留旧 lib 的历史规则不适用于此导出。公开说明和清单已校正，从 Git 重新打包的归档哈希可以不同，运行文件仍须与清单一致。旧 Release 资产保持。

## English

Version 0.8.0-local.8 moves the final cancellation check, synchronous Session transaction and pending usage recovery into the plugin. It can use the older Host without the added Basic cancellation marker, selection hook or storage drain API. It does not remove cancellation protection or require another compatibility plugin.

Download the prebuilt tarball above, verify SHA256SUMS, back up the profile including both Context domains and `.context-manager-recovery`, then update the existing plugin through **Plugins → Add plugin** and reload or restart as requested. Source publication is separate from installation. This is a public pre-release; no user machine is upgraded by publishing it.

Validation used naturally old and enhanced SDKs on Intel macOS with synthetic providers, including a 200000-token window, output reservations, cancellation at the final awaited boundary, late observed usage after storage closure, and idempotent recovery through two restarts. The old CLI installation and two cold Host starts passed. Native Ubuntu/Windows workflows and real-model semantic quality remain unverified. The exact accepted tarball is retained; current publication instructions supersede its frozen development README. Runtime bytes match the published inventory.
