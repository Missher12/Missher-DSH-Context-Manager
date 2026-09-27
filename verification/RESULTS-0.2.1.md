# 0.2.1 样式归属修复验收 · 2026-09-27

最终仅交付 `../dsh-context-manager-0.2.1.tgz`，精确大小和 SHA-256 见 `DELIVERY.json` / 相邻 `.sha256`。0.2.0 记录已保存为 RESULTS-0.2.0.md / DELIVERY-0.2.0.json，旧包保留。

## 原因及修复范围

实际运行 Desktop app.asar 的 client-modules 在每次 factory 执行后，将页面所有无 data-plugin 的 style 认领为该包；更新/卸载时删除归属于该包的样式。桥接的样式在 effect 执行时才注入，没有归属，因而后来加载的上下文包会误领它。实测升级前面板 position=absolute，清理后变成 static，与截图吻合。

- 本插件 src/client.tsx 的两处 React style 明确标记 dsh-context-manager 和稳定 CSS ID。
- 桥接原项目 src/client/index.tsx 同步明确的 bridge 归属。本任务只修改该函数中的归属属性和注释，不改桥接业务功能。
- CSS 规则/颜色/布局未变。四个 Host 构建文件（engine/policy/index/diagnostics）与 0.2.0 字节相同。
- 桥接曾在隔离副本生成 0.1.1 包，其 client.js 相对原快照只有两行属性，Host lib 相同；随后原工程发生并行工作的新构建，包含 HTTP/RPC 调整及已合入的样式标记。SHA 守卫拒绝覆盖新构建。旧快照包已撤离交付目录，只留在 style-ownership 作验证证据，不能安装它回退当前桥接。
- 最新本机桥接构建重新跑过样式生命周期回归，检查记录见 style-ownership/live-bridge-patch.json。日常 profile、官方源代码和原生应用进程没有被本任务修改/重启。

## 静态与自动验证

- 上下文 Host/Client TypeScript、构建、22/22 测试通过。设置页两处 style 均带正确归属；单独挂载设置也一样。
- 隔离桥接快照 TypeScript、构建入口加载、30/30 测试通过；原项目最小源补丁的客户端类型检查通过。此 30 项结果不冒充并行工作后来业务改动的完整验收。
- 使用从实际安装 Desktop 提取的 client-modules、真实 Cordis Loader/Entry，以及实际构建的插件工厂。UI slot 服务在此测试中为空夹具。`node verification/style-ownership/run.mjs --after` 验证原 0.1.1 误领/删样式；修复后更新、卸载、再装上下文都保持 bridge 样式，桥接自己重载只留一份，自己卸载会清理。当前本机桥接新构建也通过同一回归。

## 官方 Web / 最终包

使用隔离 DSH_HOME 下 context-manager-test profile；宿主源码 0.1.7-rc.2 / e3409377ac873963595b76c0eb9afd8a8aa241af。

- tgz 经官方 CLI 安装；插件管理页实点热卸载、重新安装、启用。没有通过页面刷新掩盖热卸载问题：桥接 style 始终保留正确 owner。
- 最终修复代码经重新安装及 Web 页面核验：会话标识按钮高度 22px，面板 position=absolute；设置页仍是原生概览/压缩设置布局，两个 style 归属均正确。
- 最终模拟会话的历史读取、概览读取成功；无控制台 error，模拟占用 15.09%。截图 panel-fixed.png / overview-fixed.png；数值记录 ui-final.json，热循环记录 web-hot-cycle.json。
- 最后仅调整 README，说明本机桥接已被后续构建更新、不交付旧快照桥接包；最终 tgz 的所有 lib 与已验证文件字节一致。
- 试验服务及页签已关闭，两个测试 Bundle 已移除，模拟日志保留。卸载时首次误传 pnpm remove 不支持的 --offline，未产生卸载动作；改用正确命令后成功，日志分别保留。

## 修正测试夹具，不改生产会话

旧 v2 模拟种子从 user/message 起头，在首次真实日志严格读取时暴露缺少受保护 system 首节点。原始文件保留；tests/loop.test.mjs 补空系统头，新增通过官方 V4 编码再严格解码的校验。新 v3 模拟日志和页面读取已通过。修复仅影响测试构造，不修改用户历史、压缩算法或消息内容。

## 剩余边界

尚未直接查看用户原生 Desktop 窗口，不能宣称当前窗口已经自动恢复；若旧页面未收到热加载，在任务空闲时重新打开 DSH。真实模型 API 调用为 0，真实摘要质量及跨平台原生验收仍属于先前未完成范围。
