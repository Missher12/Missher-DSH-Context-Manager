# Context local.9 公开交付说明

[中文指南](README.md) · [English guide](README.en.md) · [桌面与全部插件](https://github.com/Missher12/Missher-DeepseekHarness-Desktop) · [已发布版本](https://github.com/Missher12/Missher-DSH-Context-Manager/releases)

## 当前交付状态

[Context local.9 正式 Release](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/tag/v0.10.0-local.9) 已公开，两个原始安装包及校验/验证说明共四个资产已匿名下载并核对 SHA-256。源码标签 `v0.10.0-local.9` 固定在 `6fb5dda33b2254d54721f26b47fc7897f5eab0fe`；后续 main 仅补充交付说明，原包和历史标签保留。

配套 Ubuntu Desktop `0.2.1-alpha.2.20261014.1` 已安装并原生验收，来源为 [`818b495`](https://github.com/Missher12/Missher-DeepseekHarness-Desktop/commit/818b495a877b04b53f7d07bbaec5837a0fe07c71)。Context 的23个安装文件与主包精确相同；设置页、上下文 Inspector 和三个入口激活均通过，已有会话、显式设置及学习/费用内容保留。本次安装验收没有发送模型请求。

Host 完整构建生成357个客户端产物，56项组合回归、43项文档检查、lint 和正常 Git 钩子通过。另一次 [Intel Mac CI](https://github.com/Missher12/Missher-DeepseekHarness-Desktop/actions/runs/38485572586) 完成打包、88项边界/隔离测试和实际渲染器检查；这不代表每台 Mac 的安装或插件业务已通过。桌面平台资产以[桌面正式下载](https://github.com/Missher12/Missher-DeepseekHarness-Desktop/releases/latest)中的版本和验证清单为准。

## 两个包的区别

| 包 | 选择条件 | SHA-256 |
| --- | --- | --- |
| `missher-dsh-context-manager-0.10.0-local.9.tgz` | 新 Host 提供窄 preset provider 接口；自动接续还需要同批 AgentLoop 修正 | `670e07978d98ceb0800bee021150487d1ce4c4776f3819de84e24a7d87d9c840` |
| `missher-dsh-context-manager-0.10.0-local.9-legacy.1.tgz` | 已验证的旧 Host 完整预设回退；不具备新消息自动 handoff | `7592ce7cae7e0ca9c10a6c7132fe03a2dc9c2b7b9d095a7c7567843640544ef5` |

窄接口标识为 `preset-compaction-provider-patch-v1`，四个接口源文件指纹是 `af10691561e7969fbcb9474541808b847455cd87e91339fa504610066bfdb6e5`。这个指纹只证明 preset 接口，不能替代完整 Host 自动接续补丁的验收。官方 `0.2.1-alpha.2` 包没有该接口。两个构建二选一，不叠加安装，不引入额外兼容插件。

最终整合保持同一 preset 接口契约；补充 JSDoc 和箭头参数括号后，四文件指纹从上述 `af10691561e7969fbcb9474541808b847455cd87e91339fa504610066bfdb6e5` 变为 `ddde6df7e436354318c26f0b3a1cd18f51ed4418124321cc66ae34e33448f396`。两者使用原生成器相同的固定文件顺序及 `path + NUL + fileSha256 + LF` 聚合算法。准确算法为 `sha256(concatInDeclaredOrder(path + NUL + lowercaseFileSha256 + LF))`。归档内旧指纹作为原冻结证据保留，最终 Host 的构建、安装和 UI 证据分别记录。

版本号用于定位验证基线和安装包；兼容性由必要接口、能力和实际测试确定。维护目标是覆盖合理版本范围并持续适配最新版，未测试的旧版或新版不直接标为兼容。开发依赖固定到验收 SDK 以便复现，不等同于运行时只允许该版本。

## 验证范围

| 项目 | 结果 | 范围 |
| --- | --- | --- |
| 窄包完整测试 | 392 通过 / 396 总数，4 跳过 | 模拟模型与隔离 Host；无真实模型调用 |
| legacy 完整测试 | 389 通过 / 396 总数，7 跳过 | 额外缺少3个新 Host 自动交接用例 |
| 两包 server/client 类型 | 通过 | 冻结插件源码范围 |
| Host 组合回归 | 56/56 通过 | agent-loop、preset、registry 相关测试 |
| Host 完整构建及发布检查 | `build:official`、43项文档、lint 和正常 Git 钩子通过 | 357个客户端产物；平台证据见以下各行 |
| 恢复检查 | 独立 R1/R2/R3 通过 | committed 风险授权、未派发可重新授权、prepare 取消恢复输入，以及 steer/followup 不重复派发 |
| 公开测试脱敏 | 单条定向回放通过 | 仅替换合成 evidence 路径；使用冻结 legacy 运行件完成两次压缩及 JSONL 重启回放 |
| 包内容 | 每包23文件逐字节匹配 | 与冻结 stage 一致；没有 Session Bridge、安装钩子或私有审查文件 |
| Ubuntu 日常安装与原生 UI | 已通过 | 23安装文件精确匹配，设置/Inspector 可见，三入口激活，原有数据保留 |
| Intel Mac 打包与渲染器 | CI 已通过 | 88项检查、DMG 和实际渲染器验证；非用户物理 Mac 安装或插件业务验收 |
| 真实模型摘要质量 | 未验证 | 本次验收没有发送模型请求 |

既有[跨平台存储 CI](https://github.com/Missher12/Missher-DSH-Context-Manager/actions/runs/38451852467) 第1次执行有10个作业通过，macOS + Node 24 的 archive/recovery 两个作业被取消且没有步骤记录，因此完整矩阵尚未通过。已通过项覆盖 Ubuntu/Windows 的 Node 22、24 及 macOS 的 Node 22；这只验证文件系统档案与恢复，不代表整桌面或真实模型验收。

窄包跳过项：两个需要原样旧 SDK 的旧 Host 行为测试、需要 Electron 与显式 ASAR anchor 的物理归档用例，以及需要旧 local.3 源码的 rescue 对照。legacy 还跳过摘要被新输入中断、预派发 steer、预派发 followup 的3个自动 handoff 用例，因为旧 Host 没有对应能力。跳过不记为通过。

完整测试和插件 typecheck 在最后两个 README 修正前完成；最终包与草稿只差这两个文档，代码未变。文档修正后重新做了包内容审计。esbuild 对共享 Host 的 es2024 配置有提示，插件显式构建目标是 ES2022；构建成功不扩展已验证平台范围。

## 源码与归档

根目录包含匹配窄包的42个源文件、33个测试和16个运行文件，及构建脚本和必要配置。legacy 只在[六个变体文件](variants/legacy/README.md)上不同，其余实现共享。Git 产品代码来自冻结 stage，不能用开发目录中的旧 lib 替换。

发布阶段仅整理公开说明、忽略规则及经过负责人确认的合成测试路径脱敏。冻结的两个 `.tgz` 不重建、不改写；归档内文档描述构建时状态，当前交付状态以本页及 Release 为准。公开清单见 [RELEASE-MANIFEST.json](RELEASE-MANIFEST.json)。个人 profile、会话、凭据、学习数据、协调指令与私有审查材料不纳入公开导出。

源码采用 [MIT](LICENSE)，第三方署名见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。源码公开、正式 Release、每台电脑安装、原生界面和模型质量分别记录。

## English summary

The formal local.9 release contains the two unchanged archives and public verification/checksum files; all four assets were downloaded anonymously and matched. The paired Ubuntu desktop and plugin are installed and native settings/Inspector and activation were verified, with existing user data preserved. The narrow package requires the preset capability and paired AgentLoop handoff change; legacy lacks that automatic handoff. Compatibility follows required capabilities and evidenced ranges, with ongoing adaptation to the latest release.

Tests passed 392/396 and 389/396 with explicit skips. The Host passed its full build, 56 focused checks, 43 documentation checks, lint and normal Git hooks. Intel packaging and actual renderer CI passed, including 88 boundary/isolation checks. The separate storage matrix passed ten jobs with two macOS Node 24 jobs cancelled. Neither these checks nor formal publication prove real-provider summary quality, every physical Mac installation or Mac plugin business behavior. Original archives and the source tag remain unchanged; current delivery notes follow on main. Private review and user data are excluded.
