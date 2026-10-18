# Context Manager 与 Session Bridge 的产品边界

本文记录当前公开的插件职责与配置边界。

## Bundle 入口

本插件是独立 Cordis Bundle。`cordis.patch.yml` 仅包含以下两条 neutral insert：

| ID | Bundle package entry | 职责 |
| --- | --- | --- |
| `context-manager` | `@missher/dsh-context-manager` | 请求前 Context 管理与压缩侧路 |
| `context-manager-inspector` | `@missher/dsh-context-manager/inspector` | 只读 Context 查看界面 |

配置不快照或覆盖 Host presets，不关闭原生 Basic，也不在根配置直接插入压缩引擎。Bundle 作为整体由 Host 插件管理器启用、停用或卸载。

## Provider 与 Basic 归属

- Host 的 `compactionHost` API v1 及实际 Agent binding 决定是否注册 enhanced Context provider；没有该能力时保留 Host 声明的 provider 和用户 preset。
- 当 Agent 实际绑定原生 Basic 时，Context 可通过独立 sidecar 提供自己的请求压力与闲置整理状态。面板只在该 sidecar active 时显示 Context 的准入预留；waiting、unsupported 或 native-only 状态不会伪装成 Context 预留。
- Basic 继续拥有自己的 provider 选择、阈值、overflow 恢复、重试及用量记账。Context 的调用预算与账本只覆盖 Context 自己的摘要调用，不覆盖 Basic。
- Inspector 读取当前 Context、用量归属、压缩记录与来源；它不激活 Agent、不调用模型，也不修改 Session Bridge 状态。

## Session Bridge 的独立职责

Session Bridge 是独立插件，负责它自己的会话标识、跨会话路由、临时工作区和 HTTP 接口。Context Manager 不内嵌 Bridge 源码、不依赖其运行包、不安装或改写它的文件，也不接管 Bridge 的界面、配置或消息投递能力。任一插件都可独立更新、停用或卸载；修改自定义 preset 时由用户保留所需的原生 Basic 配置。

## 配置与数据

Context 设置和账本归 Context 插件及其 profile/storage domain 管理。已有 legacy Token 与 fixed-timeout 设置不会自动迁移；用户明确切换到百分比容量或 adaptive 时限并保存后才应用新模式。卸载不会删除会话、摘要历史或引用原文档案。
