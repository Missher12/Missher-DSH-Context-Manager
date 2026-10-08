# Context 0.9.0-local.1

本版将压缩改为按实际工作集规划，减少大项目中“压了又压、收益很小”的情况，并让 Agent 可以回查同一会话的原文。Windows、Ubuntu 和 macOS 使用同一个预构建插件包；这是一份预发布版本。

## 变化

- 默认保留近期原文偏好 20K、摘要上限 8,192 Token，系统指令、工具定义和当前任务单独计量。空间不足时按完整工具组调整近期保留，不再默认把总占用压到固定 55% 或 100K。保存的旧目标仍可在自定义模式使用。
- 付费调用前检查可行性，摘要后检查完整包装的占用和净收益。巨大已完成工具结果可以整理，工具配对、错误和非文本内容受保护。
- 同一批原文的自动压缩周期跨步骤与重启保存：最多两个主摘要计划、四次总调用；足够新增原文才开启新周期，相同请求不自动重复发送。许可和真实费用分别记账。
- `context_history_read` / `context_history_search` 只回查执行 Agent 所在会话的原始文本，返回来源与位置。单次最多 200 事件、32,768 字符扫描和 8,000 字符 JSON 输出，不提供跨会话或向量检索。
- 保留 local.9 的通用恢复日志修复，Windows 的 `EPERM fsync` 不再阻止初始化；取消、图片超限恢复、窄格式修复和迟到用量补记继续有效。

## 下载与安装

1. 下载 [0.9 通用安装包](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.9.0-local.1/missher-dsh-context-manager-0.9.0-local.1.tgz)，用 [SHA256SUMS](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.9.0-local.1/SHA256SUMS) 校验。
2. 等待任务结束，备份当前 profile、会话和所有插件数据。Context 需保留 `.context-manager-recovery`、`context_manager_idle`、`context_manager_summaries` 和新增的 `context_manager_cycles`。
3. 在 **插件 → 添加插件** 中选择包或填写下载地址，更新现有 `@missher/dsh-context-manager`。无需另装兼容插件或本地编译。
4. 完整退出并重开 DSH，确认版本及 `context-manager`、`context-manager-engine`、`context-manager-inspector` 正常加载，再恢复原会话。

包大小 192972 bytes，SHA256：`0f693c0b82b40d9b3cffcfab5d3abdd8079342b005f3372d53cb895edd406fcc`。

回滚先取当前备份，保留其后的会话、学习记录和周期元数据；不要用历史数据根目录覆盖新工作。Git/Release 下载本身不会更新另一台电脑。

## 验证

| 层级 | 本轮结果 |
| --- | --- |
| 增强 SDK 构建与 Host/Client 类型检查 | 通过 |
| 增强 SDK 完整回归 | 237 项：235 通过、0 失败、2 项旧环境专用另跑 |
| 自然旧 SDK 构建、类型与专项 | 48/48，零跳过 |
| 协调者独立针对性回归 | 40/40 |
| 源码、包与运行字节 | 141 源文件、19 包成员、12 运行文件核对通过 |
| 当前桌面隔离整组加载 | 174 启用项 active，11 客户端匹配，正常关闭 |
| 日常 Intel Mac 安装与重启 | 175 启用项 active，11 客户端匹配，原会话与学习内容保留 |

实际模型和嵌入调用均为零。合成回放验证协议与来源保留，不能证明真实 Qwen/其他模型的摘要语义质量。Windows/Ubuntu 完整桌面、Apple Silicon、其他官方宿主和市场上架未在本轮验收。local.9 的三端原生文件系统回归仍是历史专项证据；当前持续检查见 [Actions](https://github.com/Missher12/Missher-DSH-Context-Manager/actions/workflows/context-portability.yml)，不能当作完整桌面验收。

精确结果见 [验证记录](./verification/RESULTS-WORKING-SET-20261008.json) 和 [源码／包绑定](./GIT_DELIVERY.json)。日常 Mac 使用已验收原包 `07dcec382c5a0956d40281b6d38b234d4a633c3a172b52967709a3466cdc2faf`；公开包只更新中英文 README 和兼容说明。其余 16 文件（含全部 12 运行件、清单、预设和许可证）与已安装包完全相同；未因文档重新安装或重启。原包和完整安装备份保留。

## English

This prerelease plans compaction around the actual working set, adds durable duplicate-request/call-cycle limits, and provides bounded same-session original-text lookup. Automatic mode retains recent text plus a bounded summary without a fixed total-occupancy target. Custom saved caps remain available. It retains the shared Windows recovery fix and existing cancellation/usage guarantees.

Use the single package linked above on supported hosts, back up all three Context domains and the recovery journal, update the existing plugin and fully restart. The release differs from the installed, behavior-tested candidate only in three documentation files; every runtime byte and installation manifest matches. Intel Mac integration passed. Full remote-device Desktop behavior and real-model semantic fidelity are unverified. See the bilingual README for configuration and uninstall details.
