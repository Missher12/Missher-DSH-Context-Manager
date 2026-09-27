# 0.2.0 验证记录 · 2026-09-27

交付包 `../dsh-context-manager-0.2.0.tgz`，24,832 bytes；SHA-256 `ee1b8dbe3e0d6ca14beafc4641238441e2157aa97448944473825dd33dc02046`。原始 0.1.1 结果另存 `RESULTS-0.1.1.md` / `DELIVERY-0.1.1.json`，旧安装包保留。

## 静态与离线

- 宿主源码 0.1.7-rc.2 / e3409377ac873963595b76c0eb9afd8a8aa241af；工作树干净，未修改官方源码。
- `npm run typecheck`：Host、Client 两个独立严格 TypeScript 程序通过。`npm run build` 通过。
- `npm test`：22/22 通过，见 `tests-0.2.0.log`。保留原有真实 AgentLoop + 模拟适配器的 79.9%、输入保护、工具配对、失败/取消、模型路由、图像、溢出及回放测试。
- 新增诊断投影的真实服务注册、成功/失败记录和冷回放一致性；紧邻替换证明、反向 seq 端点、替换后失败不假称回滚、旧开始事件中断、prune、12/8 有界记录及不复制内容。
- UI 测试使用宿主真实原语实现：设置草稿跨页签保留、订阅释放、选择会话、未知用量不显示假零、超过 100% 不隐藏、组成和累计用量不混入占用。
- 最终包中的 `lib/engine.js`、`lib/policy.js` 与 0.1.1 字节相同。新增代码不改变压缩执行顺序。

## 官方 Loader / profile / 包

- 仅使用 `verification/profile` 下的 `context-manager-test` profile。最终 tgz 经官方 CLI `add --offline --ignore-scripts` 安装成功，版本/文件清单见 `pack-0.2.0.json`。
- 包内只有 manifest、lib、overlay、README、兼容说明和许可证；研究源码、测试数据、profile、凭据、截图、node_modules 均未打包。
- pnpm 静态 peer 检查报告 host peers 未作为 profile 的 npm 直接依赖安装，记录在 `peers-0.2.0.log`。实际宿主 Loader 解析并加载成功；兼容结论以当前固定宿主的运行结果为限。
- 卸载成功；5 项原有根 compaction / preset 配置与基线相同，插件行移除，用户策略保留；见 `uninstall-result.json`。3 份隔离会话日志仍存在，卸载后路径、大小和 hash 记在 `DELIVERY.json`，未声称其卸载前后字节相等。
- 测试服务已停止，浏览器测试页已关闭；未安装到用户日常 profile。

## 真实 Web 页面

最终 tgz、官方 Web、模拟适配器生成的真实 AgentLoop 历史；没有真实 API Key 或模型调用。`ui-0.2.0.json` 保存观察结果。

- 仅设置页入口；原生 SegmentedTabs 分成“上下文概览”“压缩设置”。
- 会话切换后显示：占用约 1,509 / 10,000、15.1%，最近实测输入 1,500；系统/工具/消息估算 16 / 27 / 177。界面不强行让两套口径相加一致。
- 展开工具定义看到 1 个工具及其估算；压缩记录显示片段约 7,908 → 120 Token，已完成；最近 2 次主请求各输入 1,500、输出 40，宿主累计非缓存输入 2,400、缓存读取 600、输出 80。
- 70%/40% 保存并刷新仍存在；恢复 80%/55% 成功；切换页签保留未保存草稿。
- 浅色、深色检查通过，主页面和当前 panel 无横向溢出，控制台 error 0。
- 截图：`overview-light-0.2.0.png`、`overview-dark-0.2.0.png`、`overview-details-0.2.0.png`。

离线夹具的首次数据没有 cwd，因此未出现在宿主的冷会话列表；重复启动曾出现该测试 SessionAlreadyExistsError，保留于 `web-0.2.0-fixture.log`。修正夹具的唯一 ID 与 cwd 后，`web-0.2.0-final.log` 无启动错误并完成上述验收。夹具行已从隔离 profile 移除，未打包到插件。

## 未完成的验收与范围

- 尚未调用真实模型，中文/图像/长推理的摘要质量、真实成本仍未验证。
- 尚未通过原生 Desktop 安装器验证；当前是固定宿主的 Web profile 验收。
- 不包含全文上下文浏览器、六类内容细分、历史召回工具或跨重启自动续跑。没有安装或运行研究的第三方插件。
