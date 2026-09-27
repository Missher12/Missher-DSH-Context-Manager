# 验收记录 · 2026-09-27

交付：`dsh-context-manager-0.1.1.tgz`，17,399 字节。0.1.0 的包与记录仍保留，旧记录见 `RESULTS-0.1.0.md` / `DELIVERY-0.1.0.json`。

SHA-256：`e89b2ab4c4c7de0450952c03b03e3fc41c839e3de169aa36ddce7a192c271566`。

宿主：DeepSeek Harness `0.1.7-rc.2`，源码 SHA `e3409377ac873963595b76c0eb9afd8a8aa241af`。检查结束时该源码工作树仍干净。开发/测试使用 Node `25.6.0`；包安装由宿主 CLI 和 pnpm `11.1.3` 完成。

## 按层结果

| 层级 | 结果 | 证据与边界 |
|---|---|---|
| 编译 | 通过 | esbuild 生成 Host、Engine、Client、共享策略；无内部源码路径运行时导入 |
| 静态类型 | 通过 | 严格 TypeScript `tsc -p tsconfig.json` |
| 自动化行为 | 16 / 16 通过 | `tests/loop.test.mjs`、`tests/settings.test.mjs`；真实 Harness AgentLoop + 模拟适配器，不是真实模型 |
| settings 页面注册 | 通过 | 仅 `settings.section`，没有 composer/聊天框入口 |
| 真实 Web UI | 通过 | 从 0.1.1 tgz 安装的独立 profile 启动，出现“设置 → 上下文管理”；70%/40% 保存，刷新后仍为 70%/40%；随后恢复 80%/55% |
| 原生设计一致性 | 通过 Web 层验证 | 使用宿主 SettingsForm/Button/Input/Switch 和主题变量；浅色、深色实机浏览器截图已检查；16px 标题，内容宽 559px 时无横向溢出，控制台错误 0；不等同于原生 Desktop 验收 |
| 宿主设置持久化 | 通过 | 页面显示“已保存”；临时 profile patch 中 `context-manager.config.policy` 与保存值一致 |
| 源码链接安装 | 通过 | 官方 `dsh plugin ... add <目录> --offline --ignore-scripts`，配置展开和真实 Web boot 成功 |
| tgz 安装 | 通过 | 官方 CLI 离线导入最终格式 tgz，真实 Web profile boot 成功；不等同于原生 Desktop 导入 |
| 卸载回退 | 通过 | 官方 CLI remove；根 compaction 行和 Standard/PTC/Cordis/Minimal 五个原始配置行逐一与安装前一致；插件行消失，用户策略覆盖保留 |
| 原生 Desktop | 未做 | 未修改日常 Intel Mac 应用/profile，也未做 Windows/Ubuntu 安装验收 |
| 真实模型 API | 未做 | 未配置 API Key，未调用真实模型；摘要语义质量、价格、耗时未实测 |

## 自动化覆盖

1. 80% + 1% 提前检查，以及输出预留降低实际检查线。
2. 摘要完成 → 主模型 → 工具，最新任务原文和消息 ID 不变，任务只追加一次。
3. 摘要失败不启动业务请求，并拦住 `llm-retry: always` 的重复尝试。
4. 摘要未缩减时暂停，历史保持可读。
5. 摘要中取消，保留已提交任务，主模型与工具调用为零。
6. 低于阈值直接执行，不产生摘要请求。
7. 实际请求切换到小窗口模型，摘要继承该模型与推理级别。
8. 超大新任务保持原文并暂停，重建次数有界。
9. 两个真实隔离 preset 的并发会话各摘要一次，没有根引擎重复触发。
10. 工具输出导致压力增长时，下一条主模型请求之前重新压缩；完整工具组不拆散。
11. **提交新任务前，计量为 7990 / 10000 Token，即 79.9%**；首条主模型请求前摘要完成。
12. 新图片按适配器视觉 Token 价格参与检查；图片和用户原文引用保留。
13. 提供方确认超限但本地估算低于目标时，仍能做有用压缩后重试。
14. 压缩后的日志可创建新 Agent 并继续，不重复压缩已足够小的历史。
15. Client 仅注册设置页。
16. 设置暂存后原子保存完整 policy，并携带配置 revision。

## 本轮修复与限制

0.1.1 只调整设置页、客户端构建/测试与说明。去除硬编码蓝色卡片，改用 DSH 原生控件、设置行与主题变量；高级参数默认折叠。滑块键盘左移后数字同步至 79.9，重新载入可放弃编辑。关闭自动压缩时，示例明确显示关闭状态。原压缩引擎未改动。

0.1.0 中测试发现真实 preset 的服务不由 `agent.ctx.get()` 独立解析，已改用公开的 `agentPresets.serviceFor()`。另发现估算外溢出时可能选中极短的旧回复，已让范围选择至少尝试足以容纳摘要的历史。0.1.1 再次通过完整 16 项矩阵。

TokenMeter 在没有可用提供方锚点时使用估算，中文等内容的误差并未通过真实 API 校准。设置中的 Token 数为明确标注的示例；实时当前会话诊断、跨重启一键恢复按钮未实现。自定义/已被用户覆盖的 preset 需要显式接入，不能据安装成功推断全部会话已接管。

临时服务器已停止，临时 profile 最终已卸载 Bundle。测试数据保留于 `verification/profile/`，不打入安装包；原始 Web 日志含临时本机连接令牌，勿发布。可分发包只含实现、配置、兼容信息、说明和许可证。

机器可读记录：`DELIVERY.json`、`ui-0.1.1.json`、`uninstall-result.json`、`pack-0.1.1.json`。测试日志见 `tests-0.1.1.log`；主题截图见 `settings-light-0.1.1.png` 和 `settings-dark-0.1.1.png`。真实 Web 的交互证据也在本任务工具记录中；没有把 JSDOM 测试描述为原生 UI 验收。
