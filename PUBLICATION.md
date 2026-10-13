# Context local.9 公开交付说明

[中文指南](README.md) · [English guide](README.en.md) · [桌面与全部插件](https://github.com/Missher12/Missher-DeepseekHarness-Desktop) · [已发布版本](https://github.com/Missher12/Missher-DSH-Context-Manager/releases)

## 当前交付状态

插件源码和下表两个冻结包已接受进入受控桌面整合。新 Host 的完整构建及43项最终文档检查、lint 已通过；安装器、日常安装和原生界面尚待验收；当前不能把主包作为任意官方宿主的通用最新版。正式安装应以完成验收后的 Release 为准；本页不会把源码公开或局部测试等同于安装完成。

配套测试类型及接口说明已修正，`build:official` 完整构建通过并生成357个客户端产物。56项 Host 组合回归及改动范围内的 lint 通过；生成目录、43项最终文档检查及 lint 已完成；正常提交和推送钩子也通过。配套宿主已推送 [`818b495`](https://github.com/Missher12/Missher-DeepseekHarness-Desktop/commit/818b495a877b04b53f7d07bbaec5837a0fe07c71)，安装器封包与实际安装另验。

## 两个包的区别

| 包 | 选择条件 | SHA-256 |
| --- | --- | --- |
| `missher-dsh-context-manager-0.10.0-local.9.tgz` | 新 Host 提供窄 preset provider 接口；自动接续还需要同批 AgentLoop 修正 | `670e07978d98ceb0800bee021150487d1ce4c4776f3819de84e24a7d87d9c840` |
| `missher-dsh-context-manager-0.10.0-local.9-legacy.1.tgz` | 已验证的旧 Host 完整预设回退；不具备新消息自动 handoff | `7592ce7cae7e0ca9c10a6c7132fe03a2dc9c2b7b9d095a7c7567843640544ef5` |

窄接口标识为 `preset-compaction-provider-patch-v1`，四个接口源文件指纹是 `af10691561e7969fbcb9474541808b847455cd87e91339fa504610066bfdb6e5`。这个指纹只证明 preset 接口，不能替代完整 Host 自动接续补丁的验收。官方 `0.2.1-alpha.2` 包没有该接口。两个构建二选一，不叠加安装，不引入额外兼容插件。

最终整合保持同一 preset 接口契约；补充 JSDoc 和箭头参数括号后，四文件指纹从上述 `af10691561e7969fbcb9474541808b847455cd87e91339fa504610066bfdb6e5` 变为 `ddde6df7e436354318c26f0b3a1cd18f51ed4418124321cc66ae34e33448f396`。两者使用原生成器相同的固定文件顺序及 `path + NUL + fileSha256 + LF` 聚合算法。归档内旧指纹作为原冻结证据保留，不改包、不以不同算法混比；完整 Host 交付仍另行验收。

版本号用于定位验证基线和安装包；兼容性由必要接口、能力和实际测试确定。维护目标是覆盖合理版本范围并持续适配最新版，未测试的旧版或新版不直接标为兼容。开发依赖固定到验收 SDK 以便复现，不等同于运行时只允许该版本。

## 验证范围

| 项目 | 结果 | 范围 |
| --- | --- | --- |
| 窄包完整测试 | 392 通过 / 396 总数，4 跳过 | 模拟模型与隔离 Host；无真实模型调用 |
| legacy 完整测试 | 389 通过 / 396 总数，7 跳过 | 额外缺少3个新 Host 自动交接用例 |
| 两包 server/client 类型 | 通过 | 冻结插件源码范围 |
| Host 组合回归 | 56/56 通过 | agent-loop、preset、registry 相关测试 |
| Host 完整构建及发布检查 | `build:official`、43项文档、lint 和正常 Git 钩子通过 | 357个客户端产物；封包及安装另验 |
| 恢复检查 | 独立 R1/R2/R3 通过 | committed 风险授权、未派发可重新授权、prepare 取消恢复输入，以及 steer/followup 不重复派发 |
| 公开测试脱敏 | 单条定向回放通过 | 仅替换合成 evidence 路径；使用冻结 legacy 运行件完成两次压缩及 JSONL 重启回放 |
| 包内容 | 每包23文件逐字节匹配 | 与冻结 stage 一致；没有 Session Bridge、安装钩子或私有审查文件 |
| 真实模型质量、原生 UI、日常安装 | 本页尚未认定 | 格式正确、合成测试和包存在不能证明这些层级 |

既有[跨平台存储 CI](https://github.com/Missher12/Missher-DSH-Context-Manager/actions/runs/38451852467) 第1次执行有10个作业通过，macOS + Node 24 的 archive/recovery 两个作业被取消且没有步骤记录，因此完整矩阵尚未通过。已通过项覆盖 Ubuntu/Windows 的 Node 22、24 及 macOS 的 Node 22；这只验证文件系统档案与恢复，不代表整桌面或真实模型验收。

窄包跳过项：两个需要原样旧 SDK 的旧 Host 行为测试、需要 Electron 与显式 ASAR anchor 的物理归档用例，以及需要旧 local.3 源码的 rescue 对照。legacy 还跳过摘要被新输入中断、预派发 steer、预派发 followup 的3个自动 handoff 用例，因为旧 Host 没有对应能力。跳过不记为通过。

完整测试和插件 typecheck 在最后两个 README 修正前完成；最终包与草稿只差这两个文档，代码未变。文档修正后重新做了包内容审计。esbuild 对共享 Host 的 es2024 配置有提示，插件显式构建目标是 ES2022；构建成功不扩展已验证平台范围。

## 源码与归档

根目录包含匹配窄包的42个源文件、33个测试和16个运行文件，及构建脚本和必要配置。legacy 只在[六个变体文件](variants/legacy/README.md)上不同，其余实现共享。Git 产品代码来自冻结 stage，不能用开发目录中的旧 lib 替换。

发布阶段仅整理公开说明、忽略规则及经过负责人确认的合成测试路径脱敏。冻结的两个 `.tgz` 不重建、不改写；归档内文档描述构建时状态，当前交付状态以本页及 Release 为准。公开清单见 [RELEASE-MANIFEST.json](RELEASE-MANIFEST.json)。个人 profile、会话、凭据、学习数据、协调指令与私有审查材料不纳入公开导出。

源码采用 [MIT](LICENSE)，第三方署名见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。源码公开、正式 Release、每台电脑安装、原生界面和模型质量分别记录。

## English summary

The plugin source and two immutable local.9 archives are accepted for controlled Host integration, not universal installation. The narrow package needs the recorded preset capability and the paired AgentLoop handoff change; legacy uses full preset overrides and lacks that automatic handoff. Tests passed 392/396 and 389/396 respectively, with explicit skips; 56 focused Host checks passed, the full official Host build also passed with 357 client artifacts, 43 documentation checks, lint and normal Git hooks also passed. Packaging and installation acceptance remain pending. No real-provider quality or native installation acceptance is claimed here. The six legacy variant files share all other implementation with the root. Formal Release and installation remain separate from source publication; private review and user data are excluded.
