# 0.3.1 单面板与升级故障验证 · 2026-09-27

交付目录：`releases/dsh-context-manager-0.3.1/`，14 个发布文件，不含开发依赖、安装钩子或其他插件。对应 tarball 的 SHA-256：`6a02d39f99ca984bfd2d0920e0425cd69a920df059f865731f1e10aca592cb2a`。

## 用户报错的根因与恢复

实际安装的 Intel Desktop 0.1.7-rc.2 内置 Node 24.18.1。以 Electron run-as-Node 运行其 ASAR 内的真实 CLI、Loader、插件管理器和 Web 前端，使用独立 `DSH_HOME=verification/native-repro-home`。没有重启用户日常应用、修改其 profile 或读取其聊天内容。

真实界面按用户操作复现：冷启动 0.2.1 → 卸载 → 同一进程安装 0.3.0 → 立即启用。结果三个组件中只有两个 active，`context-manager-inspector` 未运行。进一步用同一 ASAR 的公开 PluginManager 方法和 Cordis logger exporter 捕获底层异常：

```
ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './inspector' is not defined by "exports"
```

磁盘上的新版 package.json 已有 `./inspector`，旧进程仍使用 0.2.1 的包导出缓存。上层只报告 `failed to import`。完整记录：`native-hot-upgrade-diagnostic.json`；复现脚本：`reproduce-native-upgrade.mjs`。这不是内容读取算法异常，也不是 Session Bridge 样式异常。

恢复方法：安装 0.3.1 后等待当前任务结束，完整退出并重开 DSH。无需卸载 Bridge、清空会话或重置压缩参数。开关插件、刷新页面、关闭窗口不会结束旧后端进程。插件没有修改 Node 或宿主加载器；不能声称支持这条跨旧导出表的免重启升级路径。

## 改动与验证

- `src/inspector-view.tsx` 移除内部 SegmentedTabs；占用、组成、内容、变化和压缩记录持续展示。分类点击在同页筛选并滚动到正文；历史按钮在同页切换不可变截面。
- 设置仍只放参数。继续使用宿主控件、主题变量和明确的样式 owner；原生入口顺序是“对话 / 轨迹 / 上下文”。
- host/client typecheck 通过；27 项测试全部通过。现有跨会话取消测试补充单面板断言，包含原有 79.9% 请求前压缩的真实 AgentLoop + 假适配器测试。
- 新版独立目录经真实桌面 CLI 安装。结束旧测试进程后冷启动，三个组件 `fiberPhase: active`，Inspector 服务存在。`native-cold-activation-0.3.1.json` 为结果。
- 使用隔离合成会话，在上述桌面运行时提供的 Web 界面完成点击验收：正文读取、组成分类与页内定位、历史截面与返回、参数页、刷新后读取均通过。面板内部 tab 数为 0；外层仍为 3 个原生页签。截图 `native-single-panel-0.3.1.jpg`、`native-single-panel-content-0.3.1.jpg`。
- 测试浏览器从此前进程重连时，宿主曾记录旧空会话 reference released / unknown session 及 Cordis runner 同步错误，保存在 `native-browser-transition-errors-0.3.1.json`。打开合成会话后，09:15 UTC 起的上下文与设置操作及最终刷新未增加错误；不把整个重连日志声称为零错误。
- 发布目录安装件逐字节匹配 tarball 的 14 个文件。所有后端 lib 和 cordis.patch.yml 与 0.3.0 相同；压缩行为未改。0.2.1 / 0.3.0 已交付 tarball SHA 不变。证据 `installed-bytes-0.3.1.json`。

## 明确的验证边界

这是实际已安装 Desktop 的后端和打包前端在隔离 Web 连接中的验证，不等于点击用户的原生 Electron 窗口。没有调用真实模型 API；没有在用户日常 profile 中代为安装或重启。升级后用户日常窗口仍需按上面的重启步骤确认。

0.3.1 完整源代码和测试在 `verification/work-0.3.1/`，独立发布目录为本次安装入口。根目录仍被用户日常 profile 以 link 引用，因此本轮保留根 package.json / src / lib 的 0.3.0 状态，避免在用户运行中替换它。以后用户切换安装路径后，才可把此源代码工作副本归并回根目录。不要再把根目录当 0.3.1 安装入口。

预览：`http://127.0.0.1:60334/`，独立合成数据，没有模型密钥；验证进程保留供查看。旧 0.3.0 预览 58550 未改。
