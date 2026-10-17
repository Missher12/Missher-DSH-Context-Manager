---
description: "在 DeepSeek Harness 中查看会话上下文，并在宿主支持时管理压缩、恢复与用量。"
kind: "package-bundle"
---

# Missher DSH Context Manager

中文 | [English](./README.en.md)

[全部插件与桌面下载](https://github.com/Missher12/Missher-DeepseekHarness-Desktop) · [插件下载](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/latest) · [反馈问题](https://github.com/Missher12/Missher-DSH-Context-Manager/issues)

`@missher/dsh-context-manager` 是 DeepSeek Harness（DSH）的上下文管理插件。它帮助你看清当前会话占用了多少上下文、哪些内容被整理、摘要是否成功，以及哪些用量仍未知。

同一个安装包按宿主实际能力运行，不要求只能安装在某个精确版本。能够加载、能够查看信息和能够执行增强压缩是不同能力，下面分别说明。

## 可以做什么

- **查看上下文**：模型窗口、占用趋势、压缩前后变化、有效正文和摘要来源，集中显示在会话面板。
- **管理压缩**：宿主支持时，在请求前检查容量，也可在任务结束闲置后整理；成功后继续原任务，避免重复已经完成的工具操作。
- **处理长任务**：按当前模型窗口计算预算，支持固定时限或按输出进展等待。未知窗口不会被猜成一个固定数值。
- **保留恢复线索**：区分派发、结果、提交与用量；遇到未知费用或中断时保留状态，不自动重放旧调用。人工恢复先预检，再由用户明确执行。
- **查看工具原文**：工具输出精简默认只观察；启用安全精简后，先保存原文，再发布短结果。失败、取消、超时或无法确认的结果保持原样。

## 兼容方式

| 宿主能力 | 插件行为 |
| --- | --- |
| 提供完整的公开 `compactionHost` v1，且当前 Agent 实际绑定本插件 | 使用增强压缩、恢复及相关操作 |
| 没有该接口，例如本轮检查的原生官方 alpha.5、社区 rc.2 | 保留宿主原生压缩器和用户预设；提供只读信息与设置保存，不启用增强压缩 |
| 使用自定义预设、其他压缩器，或当前绑定不可用 | 如实显示实际绑定；不覆盖用户选择，不冒充增强已开启 |

安装依赖采用版本范围，运行时再检查接口。范围内的每个历史版和未来版并未全部测试；具体实测环境见 [COMPATIBILITY-REPORT.json](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/COMPATIBILITY-REPORT.json) 与 [发布说明](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/PUBLICATION.md)。开发依赖中的固定 SDK 用于重现构建，不是用户安装时的精确宿主版本限制。

## 安装与升级

1. 从 [正式 Release](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/latest) 下载插件 `.tgz`，核对该版本附带的 SHA-256。
2. 在 DSH 插件管理中安装这个文件。它是插件包，不是桌面安装器。
3. 按宿主提示正常重启，然后打开“设置 → 上下文管理”和会话内的上下文面板。
4. 查看面板的实际能力状态。保存成功表示设置已保存，不能单独证明增强压缩已经启用。

新版中性 Bundle 只有 Manager 与 Inspector 两个根入口，不再复制整套宿主预设，也不要求手动禁用 Basic。不要为了凑旧版条目数量，额外添加根级 Engine。

升级会保留旧容量方式和固定时限。若需要改为百分比预算或按进展等待，请在设置中选择后保存；升级本身不会替你提高预算或重新领取恢复额度。旧的 `variants/legacy` 文件属于历史回滚线，新安装使用当前同一包。

## 常用设置

以下为新安装默认值；旧安装以自己的保存值为准。

| 设置 | 默认行为 |
| --- | --- |
| 请求前检查 | 开启；触发比例 80%，还会考虑输出预留和安全空间 |
| 工作历史 | 自动工作集；近期原文预算为模型窗口的 10%，摘要输出预算为 4%，仍受协议与模型上限约束 |
| 压缩等待 | 最多 600 秒；首个有效输出最多等 120 秒，连续无有效输出最多等 180 秒 |
| 闲置整理 | 任务结束后闲置 15 分钟且占用达到门槛才考虑；应用关闭后不执行 |
| 工具结果精简 | “观察”；默认不改动工具结果 |

自动工作集不承诺把压后总占用固定成某个百分比。历史正文、系统指令、工具定义、新消息与输出预留都影响是否能继续请求。

摘要会消耗模型 Token。用量缺失显示“未知”或“已知下界”，不能把它看作免费；字符减少量也不等于实际节省 Token。确定性的格式包装修复在本地进行，不为此再请求模型。

## 数据与恢复

会话原文、只读工具档案、摘要账本和人工恢复记录均留在自己的 profile。只读查看不应启动模型、恢复冷 Agent 或消费恢复授权。

自动额度用尽后，使用面板里的人工恢复预检查看当前条件；取消、未知费用和不能确认提交的状态不会靠重启或清空记录变成成功。备份和回滚时一起保留会话、原文档案、账本及新增恢复记录，避免丢失升级后的数据。

## 界面预览

官方 alpha.5 的实际 Web 页面，使用隔离的合成会话。该宿主没有增强接口，因此画面明确显示“只读”；没有请求记录的用量保持未知。

![官方宿主上的只读上下文面板](https://raw.githubusercontent.com/Missher12/Missher-DSH-Context-Manager/v0.10.0-local.11/docs/screenshots/context-official-readonly.jpg)

下面为真实插件组件配合合成数据的效果预览，用于展示占用、压缩变化和累计用量。它不是原生安装或真实模型运行证明，图上保留了预览标记。

![增强模式组件预览，全部为合成数据](https://raw.githubusercontent.com/Missher12/Missher-DSH-Context-Manager/v0.10.0-local.11/docs/screenshots/context-enhanced-preview.jpg)

## 验证与开发

当前发布的精确版本、源码与安装包哈希、各层检查结果和未验项目统一记录在 [发布说明](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/PUBLICATION.md)。原生界面、实际收费模型和其他机器的运行效果不会从离线测试推定为通过。

源码位于 `src/`，测试在 `tests/`，构建与平台检查在 `scripts/`。使用仓库的开发 SDK 链接和锁文件准备环境，再运行 `npm run typecheck`、`npm test`、`npm run build`；升级发布时遵循配套测试说明。仓库包含可安装运行件，普通用户优先下载正式 `.tgz`。

许可证：[MIT](./LICENSE)。第三方声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
