# 上下文管理插件的修改边界

- 最新 0.3.4 的源代码在根目录；独立安装入口 `releases/dsh-context-manager-0.3.4/`。2026-09-28 已现查日常 profile 指向独立 0.3.3 发布目录，本轮不修改日常安装件。修改前仍需现查有效路径；已交付版本不原地覆盖。
- 用户最新要求：“上下文”只显示少量关键数据、紧凑布局，不显示发送区；详细内容在同一页展开，不加内部页签。峰谷提示的显示条件仅是选中官方 DeepSeek 模型，与上下文百分比、历史记录、是否发送过消息无关。提示位于模型选择器旁的 `conversation.input.right`，新会话默认官方模型也要显示；切到非官方模型即隐藏。
- 峰谷提示共享原生 `modelDirectories.directoryFor(sessionId).store.current`，跟随模型选择器已接受的选择，不另外发 RPC。Cordis 的服务方法按调用者上下文检查依赖，必须同时声明 `modelDirectories`、`sessions`、`remote`、`remote.session`；仅声明根 `remote` 会在新目录首次创建时报错。需验收新会话、切换模型与冷启动浏览器日志。
- `readonly-view.ts` 仅在当前上下文视图挂载期间隐藏其祖先会话的常驻 composer seat；切走恢复原 display/hidden/inert，保留草稿，不全局匹配或改公共样式。布局标记变化需重新验收。


- 本目录是独立的 `dsh-context-manager` Bundle。职责是请求前压缩、压缩设置和只读上下文详情。用户于 2026-09-27 明确位置：在原有“对话 / 轨迹”同一排的“轨迹”后增加“上下文”视图；设置页只保留压缩参数。此要求取代此前设置页入口及输入框摘要加侧栏方案。正式入口使用 `conversation.view`，上下文数据不另加 composer dock 或右侧面板；用户新授权的官方峰谷提示使用 `conversation.input.right`。用户后续已授权正式实现；0.3.0 接入真实只读数据，0.2.1 安装包仍保持原字节。
- 先读 `PROJECT_CONTEXT.md` 和 `PLUGIN_BOUNDARIES.md`，保留已交付 tarball 的内容与 SHA。文档或验收补充不覆盖已经给用户的同版本安装包。
- Session Bridge 由任务 `01a0e136-a8b3-7cb1-b322-aa0813ec29d9` 单独维护。可以只读核验，不直接修改、构建、打包或发布其源码、lib、manifest、配置及文档；跨插件修复先交接给其负责人。
- 本插件不能依赖、内嵌、安装或代为修复 Session Bridge；不得增加对方样式选择器、清理器、服务或跨会话工具。使用 DSH 官方 Session/Projection/Compaction 接口是本插件职责，不等于依赖 Session Bridge。
- CSS 限于 `.dsh-context-settings`，所有 style 节点显式带 `data-plugin="dsh-context-manager"`；清理仅归属自己的节点，不扫描或删除页面其他样式。
- 宿主 `client-modules` 的通用修复必须是单独的上游改动，不藏入本插件安装包。日常 profile 与正在运行的应用继续遵循用户明确约束。
- 按影响验证。交付包执行 `node scripts/verify-package-boundary.mjs /absolute/path/package.tgz`；两插件共存/热更新证据与原生点击验收分开报告。`verification/` 的 Bridge 快照仅为历史证据，禁止当作当前 Bridge 交付。
