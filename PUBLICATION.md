# Context 0.10.0-local.1 候选验证

当前分支用于对冻结的上下文效率升级运行 CI，还未成为 main、tag 或 Release，也未安装到日常 DSH。当前已发布版本仍为 [0.9.0-local.2](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/tag/v0.9.0-local.2)。

新版增加安全工具结果精简、保留原文与同会话/合法继承前缀回读、实际用量归因和原生上下文页面。默认 observe，只观察；使用 reduce 才对新成功的可识别纯文本结果尝试精简。原文 blob 默认上限为 512 MiB，三份索引清单各自上限 64 MiB；没有自动清理原文或关闭长期保留的选项。

精确来源与包文件绑定见 GIT_DELIVERY.json。包 SHA256 为 `32d87ca6c961c75e516003acf32065bf7500a9da0d549190ef15e3a863ef7b95`，23 个成员含 16 个运行文件。本分支没有修改冻结业务或用另一份 SDK 替代增强基线。

r2 仅修正引用列表的一处文案，对应 locales 与 client 两文件变化；设置和传输协议定向 29/29 通过。下列完整回归基于 r1，未改模块逐字节一致，不称 r2 重跑全量。r1 增强 SDK 全量为 279 通过、2 个仅旧能力场景跳过；旧 SDK 指定历史 48 项及新适配 28 项通过。旧 SDK 额外全量仍有 46 失败/6 取消，含 idle 的额外子集仍有 4 失败，失败证据保留，不能称所有旧宿主全面兼容。独立本机反例分别为核心 13、归因 8、归档故障 3、生命周期 3 项通过。

CI 将分别运行 archive 与 recovery 的 Windows/Ubuntu/macOS × Node22/24 矩阵，仅验证原生文件系统和明确的故障合同。archive 三例要求真实故障命中并记录原文、清单及总物理字节；原文配额断言不等于整个目录总配额。实际浏览器页面被 ERR_BLOCKED_BY_CLIENT 拦截，视觉未验收。完整 Host、UI、V4/分叉恢复仍由负责人单独验收，CI 不启动 Desktop、不调用模型，不替代这些结果。

仅当正式 CI 和最终独立验收完成后，协调者才可推进 main/tag/Release；日常安装和重启另按明确交接执行。

## English

This is a frozen CI candidate, not a release or daily installation. Archive and recovery are separate native-filesystem matrices; no replacement SDK, Desktop, or model call is used. Extra legacy full-suite failures remain recorded. Final Host/UI/storage acceptance and all required CI results are required before main/tag/release publication.
