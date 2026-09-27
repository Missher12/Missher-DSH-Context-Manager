# 0.3.3 紧凑只读上下文与 DeepSeek 峰谷提示

2026-09-27。安装目录 `releases/dsh-context-manager-0.3.3/`，14 个文件，SHA-256 `ebbc2be02f7387013a8fbdcef57a6e050b2f33319518ceee1800884a05cfd845`。tarball 与目录逐字节匹配；0.2.1 / 0.3.0 / 0.3.1 原交付 SHA 未变。0.3.2 为本轮紧凑布局阶段包，最终使用 0.3.3。

## 改动

- `src/inspector-view.tsx` / `inspector.css`：3 个关键指标、占用最多的 3 类和最近 2 条压缩记录；卡片和行间距收紧。完整数据仍在同一面板展开，无内部页签；折叠不读取正文。
- `src/readonly-view.ts`：宿主没有每页输入区开关。使用当前会话祖先的布局标记定位常驻 composer seat，挂载时隐藏并 inert，卸载恢复原属性。保留草稿，不修改宿主、全局 CSS 或其他插件。
- `src/deepseek-period.ts` / `peak-indicator.tsx` / `peak-indicator.css` / `client.tsx`：通过官方 composer dock 插槽追加一个同风格时段提示，自身 CSS order 将其排在原有百分比后。读取当前会话 `modelSelection.next`，只匹配内置官方 API Key / Account 路由及官方已知模型；第三方同名模型不显示。
- 峰谷按北京时间，使用 [DeepSeek 当前价格说明](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（2026-09-27 核验）及 [国务院 2026 假日安排](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)。节假日按公布的放假日期解释；周末调休工作日仍按周末规则。未覆盖年份显示待核对；不是账单估算，不探测用户自定义代理或重定向收费。按分钟边界及页面恢复可见/焦点时刷新。

## 验证

- 构建、host/client typecheck 通过；32 项测试通过。包含切换会话取消、按需正文、单页展开、输入区局部隐藏及原状态/草稿恢复、官方路由切换、9/12/14/18 点边界、时区等价、周末及国庆假期、下一切换时间和未知年份。
- 使用已安装 Intel Desktop ASAR 内的真实 CLI/Loader，以独立 DSH_HOME 安装最终目录并冷启动，3 个组件均为 active。所有 backend lib 与 cordis.patch.yml 同 0.3.1；压缩引擎及设置算法未变。
- 实际桌面运行时提供的隔离 Web 页面：官方模型时“15%”右侧为“低谷期”，位置以 DOM 几何核验；键盘聚焦显示规则和下次切换时间，第三方 mock/large 会话不显示提示。当前日期真实为低谷，峰值由离线边界测试覆盖，没有修改浏览器时钟。
- 紧凑页默认 3 类、1 条实际夹具压缩记录，详细正文未挂载；隐藏发送区、无水平溢出。展开正常读取正文，外层仍为 对话 / 轨迹 / 上下文。3.2 浏览器草稿恢复通过，同逻辑在最终 3.3 回归测试通过。
- 截图 `native-compact-0.3.3.jpg` / `native-official-period-0.3.3.jpg`。数据为隔离合成会话，未调用真实模型。

## 交付边界

此处是桌面打包运行时 + Web 点击验证，不是用户原生 Electron 窗口的点击或原生安装器验收。没有修改日常 profile、重启日常应用或修改 Session Bridge / 共享宿主源码。日常仍为 0.3.1，需从插件管理入口选择最终安装目录。

根目录当前已是 0.3.3 权威源码：现查日常只链接独立 0.3.1 发布目录后，先备份差异文件到 `verification/before-0.3.3-root/source.tgz`，再归并验证过的源码与 client 构建；后端文件未覆盖。预览地址 `http://127.0.0.1:60334/`。
