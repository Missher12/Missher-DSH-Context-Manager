# 0.8.0-local.7 源码交付 / Source delivery

此提交提供已完成隔离验收的插件源码和九个预构建运行文件，用于跨电脑同步。GitHub Release、插件市场和日常安装各有独立状态；本次 Git 推送不表示它们已更新。

## 使用前提

必须使用包含本轮安全修复的 [Missher DeepSeek Harness Desktop 源码](https://github.com/Missher12/Missher-DeepseekHarness-Desktop)：摘要提交前复核取消，以及 JSON 存储关闭前等待消费者记账收尾。对应宿主提交为 [`4de855b521`](https://github.com/Missher12/Missher-DeepseekHarness-Desktop/commit/4de855b52156eead14c475a8a007e58b415051f7)。缺少 `supportsSummaryAbortCommit === true` 或两个存储域的 `registerDrain` 支持时，插件会在收费摘要调用前停止；不应通过调版本号绕开能力检查。

本仓库的 `lib/` 是 0.8.0-local.7，对应下方冻结包；维护电脑原开发目录保留旧 lib 的约束不适用于本公开导出。可以在匹配宿主上使用本源码自带运行文件或自行打包；只从实际存在的 Release 下载资产，不把此前 0.7 的资产当作 0.8。

## 本版行为

- 请求前压缩和闲置整理共用有效预算，可选绝对软触发/目标默认关闭，初始值为 200,000 / 100,000 Token；不改模型总窗口。
- 规范化允许的摘要包装；仅对数组字段误写为字符串执行一次有预算的格式修复，校验失败保留原历史。
- 取消时阻止未提交摘要替换历史；迟到模型用量逐项幂等补记，卸载和关停等待收尾。
- 上下文页显示预算来源、摘要修复阶段和 Goal 停因；Goal 轮数和 MSE 预算保持独立。

## 核验与限制

冻结源码 105 文件和安装包 16 文件已核对；本提交只另行更新发布说明，九个运行文件逐字节相同。local.7 的实际构建 codec / Inspector 回归 11/11 通过。组合桌面在独立 profile 加载 202 条 Loader，174 个启用项全部 active，九份客户端文件匹配，模型及外网请求为 0，正常关停完成；安装事务六种故障注入场景通过。

宿主修复有压缩 157 项和存储 98 项回归；最终静态修订后相关 75 项重跑属于前述集合，不重复统计。完整验证使用 Intel macOS 的定制 rc.2。其他平台、纯官方新版、大项目持续运行的摘要语义保真及本机原生点击没有因此获得验收。

冻结 Context tgz 的 SHA256：`d749f3c21f7e90fb969376ee009a01ef1603690edfeef780496e94f3ad206ffd`。本 Git 提交中的 README 和兼容说明补充了发布信息，因此从 Git 重新打包得到的 tgz 哈希可以不同；运行文件应与 [GIT_DELIVERY.json](./GIT_DELIVERY.json) 清单一致。原冻结包不原地改写。

## English

This source publication includes the accepted 0.8.0-local.7 runtime. It requires the corresponding host cancellation-before-commit and JSON storage consumer-drain fixes; missing capabilities block paid compaction. Source publication, downloadable Release assets, marketplace status and daily installation are separate. The runtime matches the frozen candidate byte for byte; only publication documentation differs. Validation covers isolated Intel macOS custom rc.2, not every platform or long-project semantic fidelity.
