# Context Manager 0.10.0-local.11

[中文使用说明](./README.md) · [English guide](./README.en.md) · [发行附件](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/tag/v0.10.0-local.11) · [配套桌面及全部插件](https://github.com/Missher12/Missher-DeepseekHarness-Desktop)

本版把固定预设覆盖改为按宿主公开能力接入。安装包只声明 Manager 和 Inspector：有完整 v1 能力且当前 Agent 实际绑定 Context 时启用增强；否则保留原生压缩与用户预设，提供只读信息和设置保存。不会因为设置保存成功，就提示尚未运行的增强功能已生效。

## 本版修复

- 请求前把新输入纳入容量判断，自动工作集为后续任务留出空间。
- 压缩成功后继续同一任务；取消、迟到用量与提交检查保持独立，避免重复工具执行和旧调用重放。
- 记录未知用量、摘要来源及恢复授权，不通过重启、改路由或清账自动重复收费调用。
- 保留新版与旧版设置，卸除旧 Bundle 贡献的预设覆盖时不覆盖用户自定义配置。
- 更新实际界面配图、当前使用说明和能力矩阵。宽窄布局、只读状态与未知用量均有专项检查。

## 验证范围

| 层级 | 结果 |
| --- | --- |
| 核心包回归 | 401 项，397 通过、0 失败、4 跳过。后续两次客户端修正没有改动后端，复用核心证据 |
| 实际 Loader / Manager / Agent / Provider | 6/6，通过合成 adapter 执行 summary → main → tool → main；原任务、工具与摘要用量各记一次 |
| 最终客户端 | 打包 UI 6/6；降级竞态、未知用量及中性保存反馈通过 |
| 原生官方 npm alpha.5 | 自然 Host 68 断言、只读查询和原生设置持久化通过 |
| 社区 rc.2 | 自然 Host 68 断言、只读查询和原生设置持久化通过 |
| 两种旧包升级 | 官方实际 PluginManager 替换 local.9 / legacy.1，各 31 检查通过；返回正常重启要求，未声称即时激活 |
| 实际官方 Web | 上下文页签、搜索、无聊天输入框、保存 80→82、磁盘/重开回读、1280 与 390 宽度通过；控制台错误、模型调用和外部网络尝试均为 0 |
| 图表组件 | 实际 client 与 Host 主题，合成数据；增强明暗/宽窄、native/unavailable、未知量显示通过。图库单列为组件证据 |

四个跳过项目是旧 Basic 静态形状、旧 Domain/JSON 迟到用量关闭形状、真实 Electron archive，以及 local.3 应急读写；未计入通过。

## 安装包与源码绑定

独立验收的运行基准包 SHA-256 为 `7ccd21435cf82665ae9d32e863e276307bf03536915d6675edd3a70e70f918f7`；最终 client SHA-256 为 `caa7745b4b2992b4e6bac1c6d28143562c411ab0e09033a8d91fc35090dd7ef0`。审核源码清单 SHA-256 为 `16ed8762f2113b79b29beca3d0aae921dae5f119e860b6bd64a21ffc92d98af0`。

公开发行包更新使用说明；两张配图保存在 Git 仓库，包内说明使用固定版本链接。全部运行 lib、package.json、Bundle overlay 与生成契约 COMPATIBILITY.json 保持逐字一致。**实际下载包的 SHA-256 以 Release 附件和 [RELEASE-MANIFEST.json](./RELEASE-MANIFEST.json) 为准，不用上述验收基准包的哈希替代。** 原基准包和失败证据保留在独立验收记录中；私人协调记录不进入公开仓库。`COMPATIBILITY.json` 是实现阶段生成并冻结的契约，其候选期验证文字属于历史快照；当前验收以本页及 [COMPATIBILITY-REPORT.json](./COMPATIBILITY-REPORT.json) 为准。

增强能力实测对应社区 Host 的 v1 源码快照：基线 commit `0ff7e27023e4791dacef8d55cfb90de962fb2a77`，源码文件清单摘要 `43fc7611117b4b2c096bb3170753fbd97ac442d71079d0b1e765c819e88b7737`。这是测试身份，不是安装时写死的版本门槛；完整配套 Host 交付见桌面仓库。

## 边界与升级

官方 alpha.5 和社区 rc.2 本身没有 `compactionHost` v1；本次证明它们可保留原生功能并运行只读面板，未证明增强压缩在这些原生版本中可用。自定义预设或其他 provider 不被强制替换。

本次没有实际调用收费供应商或用户 Qwen 服务；真实摘要质量、延迟和账单没有验收。原生 Electron、社区 staged update/HMR、Mac/Windows 的实际 Host 与用户机器安装另行验证。Git、Release、源码测试和本机已生效是独立状态。

升级保留旧容量模式、固定时限和账本。正常退出、建立完整备份，再按宿主提示升级/重启；不要自行添加旧 root Engine 或禁用 Basic。回滚先保全升级后新增数据，不把旧会话/学习/费用账本整库覆盖回来。历史 `variants/legacy` 是旧回滚资料，不能当成本版推荐安装线。
