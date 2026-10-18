# Context Manager 0.10.0-local.12

[中文使用说明](./README.md) · [English guide](./README.en.md) · [发行附件](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/tag/v0.10.0-local.12) · [桌面与全部插件](https://github.com/Missher12/Missher-DeepseekHarness-Desktop)

本版修正百分比设置与压缩绑定状态的展示。移除已经不生效的旧修复额度控件，保留旧配置的读取与序列化；顶部常驻当前实际绑定状态，读取失败、刷新中和历史截面不会冒充当前增强状态。最近请求容量只使用同一次请求的窗口，缺少或不匹配时显示未知；真实调用及累计用量仍保留准确 Token。

本版没有改变压缩算法或费用策略。只有宿主提供完整 compactionHost v1 且当前 Agent 实际绑定 Context，才可接管增强压缩。官方 0.2.1-rc.2 没有该能力，本次验证的是保留原生压缩、只读信息与设置服务，不能把升级插件当作增强已启用。

## 本次验证

| 层次 | 结果与范围 |
| --- | --- |
| UI 相关用例 | 8 个不同用例通过：R2 重测受影响的 4 个，复用 R1 未改的 4 个；旧失败日志保留 |
| 构建与类型 | client 构建与类型检查通过；新版本只构建打包一次，client 与已验收字节相同 |
| 合成浏览器 | 14 项检查通过，1280×900 / 390×844、浅深主题、状态/失败/历史、窗口错配、百分比设置及内存保存；使用 alpha.2 源码 primitives，不是安装 rc.2 原生 UI 验收 |
| 官方 rc.2 | 缓存纯官方运行库的实际 Cordis/Loader/服务及冷会话隔离检查，70 项断言通过；Manager/Inspector 激活，增强 unsupported/inactive；原生声明与合成会话数据保留 |
| 请求与清理 | 模型、外网、子进程和 Agent 创建尝试均为 0；卸载清理及自起进程退出通过 |

旧 local.11 的全套回归、其他宿主和旧包升级证据保留在[历史发布说明](https://github.com/Missher12/Missher-DSH-Context-Manager/blob/v0.10.0-local.11/PUBLICATION.md)，未计入本次重新执行数量。README 中固定 local.11 链接的配图仍是历史图片。

## 安装包与源码

下载 `missher-dsh-context-manager-0.10.0-local.12.tgz`，SHA-256：`cf0741d238b9864ad1b74e36a49d45a089fa96a740c89c8a70260c4fe9b083d0`。

本包 24 个文件与本标签对应产品文件逐字匹配。精确清单见 [RELEASE-MANIFEST.json](./RELEASE-MANIFEST.json)，当前分层验收见 [COMPATIBILITY-REPORT.json](./COMPATIBILITY-REPORT.json)。包内 `COMPATIBILITY.json` 是构建前冻结的实现契约；其“尚未打包”文字描述当时的源码快照，交付结果以这里的独立验收为准。Git 中三份交付记录不改变已验收安装包。

依赖范围与按能力检测策略保持不变；范围内每个历史或未来版本并未全部测试。实际收费模型、摘要质量、日常或其他机器、原生 Electron/macOS/Windows UI 均未在本次验收。更小总工作集仍是研究方案，没有随本包实施。

在目标设备核对实际宿主、插件与当前会话绑定后，通过 DSH 插件管理升级并遵循正常重启提示。发布成功不表示已替换用户的日常环境。旧 local.11 发行附件和 `variants/legacy/lib` 历史回滚产物保留；升级或回滚不能覆盖用户新增的会话与费用记录。
