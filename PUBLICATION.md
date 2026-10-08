# Context 0.8.0-local.9

Windows、macOS、Linux 使用同一个 `@missher/dsh-context-manager` 插件包。本版本为预发布版，原有发行包保留。

## 解决的问题

Windows 恢复日志对目录调用 `fsync` 会返回 `EPERM`，导致主服务启动失败，引擎、详情页和会话恢复随后等待 `contextManager` / `compaction`。本版统一处理平台差异：POSIX 保持目录刷新；Windows 强制刷新普通文件，并在原子替换后再次刷新已发布文件。文件写入失败继续报错，锁、取消保护和幂等记账保持。

完整审查覆盖 31 个源码文件及构建、清单、预设。另修复摘要错误包装丢失供应商故障类型的问题，让明确的图片超限能交给宿主既有恢复钩子；普通错误和取消不会因此自动重试，各次实际调用分别记账。失败摘要诊断保留供应商原始原因，外层压缩暂停、原文保留的处理保持。

## 下载与安装

1. 下载 [local.9 通用安装包](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.8.0-local.9/missher-dsh-context-manager-0.8.0-local.9.tgz)，可用 [SHA256SUMS](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/download/v0.8.0-local.9/SHA256SUMS) 检查完整性。
2. 等当前任务结束，备份 profile、会话、`context_manager_idle`、`context_manager_summaries` 和 `.context-manager-recovery`。
3. 在 DSH 的“插件 → 添加插件”选择包或填写上述地址，更新现有同名插件。
4. 完整退出并重开 DSH，确认版本为 `0.8.0-local.9`，三个入口 `context-manager`、`context-manager-engine`、`context-manager-inspector` 正常加载，再恢复原会话。

无需另装 Windows 插件、兼容包、SDK 或本机编译。不要为解决等待错误删除原会话或恢复日志。Git 拉取、下载和实际安装是三个步骤；本次发布没有替用户机器安装。

包大小：176413 bytes。SHA256：`8a8b878b36b37fb9f356237e511df5b1513dc970ca817314e2b3573eea8d923b`。

## 验证范围

| 验证 | 结果 |
| --- | --- |
| 增强 SDK 完整回归 | 191 项：189 通过，2 项旧 SDK 专用测试另跑 |
| 自然旧 SDK 专项 | 50/50，零跳过 |
| 生命周期与准入 | 23 场景 242 项；3 场景 21 项通过 |
| Windows / Ubuntu / macOS 原生恢复日志 | 每端 23 项故障与恢复测试、6 项启动与重启检查通过 |
| macOS Intel 旧宿主行为包 | 安装 3 项，两次冷启动各 27 项，真实持久化测试会话恢复 69 项通过 |
| 正式发行包补测 | 独立安装 3 项、冷启动 27 项通过 |
| 协调者独立验收 | 110 源文件、16 包成员、10 项摘要恢复及实际协议回归、包边界通过 |

旧 Windows 故障有原生反例；回归覆盖中文空格路径、活锁及孤儿锁、普通文件刷新失败、替换后失败、链接路径保护、两次重启不重复计费。持续检查见 [GitHub Actions](https://github.com/Missher12/Missher-DSH-Context-Manager/actions/workflows/context-portability.yml)，精确结果见 [验证记录](./verification/RESULTS-LOCAL9-20261008.json)。

Windows/Linux 完整桌面操作、用户实际报错会话的恢复、真实供应商摘要质量未在本轮验收。测试没有真实模型调用。Windows 权限继承 profile 的 ACL，不能把 POSIX 权限位与目录刷新保证照搬为 Windows 突然断电恢复保证。

正式包仅修正行为候选的中英文安装说明和兼容说明。九个运行文件、清单、预设和许可证逐字节保持，因此完整逻辑与会话恢复结果明确按运行字节等价引用；正式包另跑安装和冷启动。`client.js` 相对 local.8 仅有构建工具的源路径注释变化，界面执行代码保持。

## English

One shared package fixes Windows recovery-journal startup (`EPERM fsync`) and preserves typed provider failures for the existing image-offload recovery hook. File-write errors remain fatal; cancellation, ownership and idempotent usage accounting remain enforced.

Update the existing plugin with the package above, fully quit and restart DSH, and then resume the original session. Keep the profile, sessions, both Context domains and recovery journal together when backing up. No companion plugin or SDK build is needed.

Native filesystem tests are separate from full Desktop acceptance. Enhanced-SDK regression passed 189 cases with two old-only skips; the old-SDK suite passed all 50. An isolated old Host resumed a persisted test session on Intel macOS without model calls. The user's Windows session, complete Windows/Linux Desktop workflows and real-model semantic quality still need their own acceptance. Publication does not install the package on user devices.
