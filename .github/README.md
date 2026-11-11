<div align="center">

<h1>DSH Context Manager · 上下文管理</h1>

<p><img src="../docs/images/cover-v2.png" alt="Context Manager · 上下文管理（品牌插画）" width="100%"></p>

<p>整理较早历史，让长会话带着任务目标继续。</p>

<p>
  <a href="https://github.com/Missher12/Missher-DSH-Context-Manager/releases/tag/v1.0.6"><img src="https://img.shields.io/badge/%E7%89%88%E6%9C%AC-1.0.6-4D6BFE?style=flat-square" alt="版本: 1.0.6"></a>
  <a href="https://github.com/Missher12/Missher-DSH-Context-Manager"><img src="https://img.shields.io/badge/%E6%96%87%E6%A1%A3-%E4%B8%AD%E6%96%87-4D6BFE?style=flat-square" alt="文档: 中文"></a>
  <a href="https://github.com/Missher12/Missher-DSH-Context-Manager/blob/main/LICENSE"><img src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF-MIT-6B7280?style=flat-square" alt="许可: MIT"></a>
</p>

<p><a href="#功能一览">功能一览</a> · <a href="#快速开始">快速开始</a> · <a href="#visual-guide">图解使用</a> · <a href="#使用场景">使用场景</a> · <a href="#常见问题">常见问题</a> · <a href="#详细文档">详细文档</a> · <a href="../README.en.md">English</a></p>

</div>

---

<!-- current-source -->
当前开发源码：**1.0.6** · [分支 `main`](https://github.com/Missher12/Missher-DSH-Context-Manager/tree/main)。安装包以实际 Release 为准。
<!-- /current-source -->

## 功能一览

| 能做什么 | 说明 |
| --- | --- |
| **请求前检查** | 接近上下文容量时整理历史，默认检查线为 80%。 |
| **空闲整理** | 任务正常结束后计时，默认空闲 15 分钟再处理。 |
| **任务摘要** | 保留目标、约束、已完成、待办、证据与下一步。 |
| **原文追溯** | 随时查看摘要和保留的来源原文，核对压缩结果。 |

## 快速开始

1. 从 [Releases](https://github.com/Missher12/Missher-DSH-Context-Manager/releases/tag/v1.0.6) 下载对应版本的 `.tgz` 安装包。
2. 在 DSH **插件 → 添加插件** 中选择下载的文件，安装并启用；按宿主提示重新加载或正常重启。
3. 在 **设置 → 上下文管理** 调整策略，在会话 **上下文** 页查看结果。

<!-- visual-guide -->
<a id="visual-guide"></a>

## 图解使用流程

长会话继续之前，先看容量，再核对留下的任务摘要。

![上下文管理：四步使用流程](../docs/images/workflow-guide.svg)

[查看完整流程图](../docs/images/workflow-guide.svg)

| 步骤 | 怎样操作 | 需要留意 |
| --- | --- | --- |
| 1. 查看占用 | 在会话“上下文”页查看当前容量、变化趋势及已有压缩记录。 | 容量描述本轮上下文；历史累计 Token 不是同一个指标。 |
| 2. 设置策略 | 在设置中确认自动压缩、触发比例与空闲整理。 | 默认检查线为 80%，空闲整理默认 15 分钟；实际判断包含模型请求预留。 |
| 3. 继续任务 | 达到条件后整理较早历史，再继续原来的工作。 | 摘要应清楚保留目标、约束、已完成、待办、证据和下一步。 |
| 4. 核对结果 | 展开摘要，遇到关键决定时回看保留的来源原文。 | 摘要是任务索引；校验失败时保留原文，不把失败算作整理成功。 |

### 试一次

> 继续这个长会话中的修复任务。先核对已有摘要里的目标、限制和待办，再处理下一项；涉及之前的关键决定时回看来源。

使用后可以这样核对：

- 摘要中的任务目标与用户最后一次要求一致。
- 已完成和未完成事项分开，关键文件或证据仍有出处。
- 查看摘要不会调用模型；新生成摘要会产生相应模型用量。

### 设置怎么选

| 项目 | 建议 |
| --- | --- |
| 自动压缩与触发比例 | 先沿用推荐值；结合实际模型窗口判断，避免把示例百分比当成固定剩余空间。 |
| 空闲整理 | 适合任务正常结束后整理；仍在执行的任务与短暂停顿不能当成同一种空闲。 |
| 摘要与原文 | 需要核对时先展开来源；更新插件不需要清空会话。 |

<!-- existing-screenshots -->
### 界面示例

<table><tr><td><a href=".././docs/images/context-compaction-overview.png"><img src=".././docs/images/context-compaction-overview.png" alt="上下文总览：容量、变化趋势、压缩结果与摘要" width="100%"></a></td><td><a href=".././docs/images/context-summary-details.png"><img src=".././docs/images/context-summary-details.png" alt="结构化摘要与来源原文" width="100%"></a></td></tr></table>

<sub>来自项目已有文档；截图版本与验证范围见<a href="../README.md">原始说明</a>，点击可放大。</sub>
<!-- /existing-screenshots -->

左图先看容量和压缩记录，右图再读结构化摘要与来源。图表用于定位变化，摘要内容才决定能否准确接着工作。

![上下文管理：会话用量与费用展示的已有版本示例](../docs/images/context-session-cost-desktop.png)

<sub>补充读图：会话用量与费用展示。图片来自已有文档，口径和版本以项目原说明为准。</sub>
<!-- /visual-guide -->

## 使用前了解

- 实际请求检查线结合模型预留调整，压缩比例随内容变化。
- 查看不调用模型；生成摘要会产生模型用量，摘要校验失败时保留原文。

<!-- readme-expansion -->
## 使用场景

| 遇到的情况 | 怎样使用 |
| --- | --- |
| 一个任务聊了很久，较早的约束容易被挤出上下文 | 将较早历史整理为任务摘要，让目标、限制、已完成工作与下一步继续可见。 |
| 需要知道本轮上下文到底占了多少 | 在上下文页查看容量、趋势、压缩结果，并展开摘要核对内容。 |
| 压缩后仍要追溯某个决定的出处 | 保留来源原文入口，把摘要当作继续工作的索引。 |

## 常见问题

<details>
<summary>为什么还没自动压缩？</summary>

触发会结合当前模型窗口、已有上下文和请求预留判断；空闲整理从任务正常结束后开始计时。插件已启用不等于每一轮都会立即压缩。

</details>

<details>
<summary>看图表和查看摘要会调用模型吗？</summary>

查看已有结果不调用模型。生成新的摘要会使用配置的模型并产生相应用量，空闲整理也应按这个口径理解。

</details>

<details>
<summary>摘要就是全部原始记录吗？</summary>

摘要用于保留继续任务所需的重点，原文可按来源追溯。校验失败时保留原文，不把不合格摘要当作成功结果。

</details>

## 搭配使用

与 [使用统计](https://github.com/Missher12/Missher-DSH-Usage-Statistics) 配合，可以分别观察当前上下文容量与长期 Token 活动；与 [Memory Native](https://github.com/Missher12/Missher-DSH-Memory-Native) 配合，则分别处理本轮历史整理和跨会话的长期记忆。

## 升级与数据

升级沿用原插件实例和当前配置。压缩设置影响后续整理行为；查看、压缩与删除记录是不同操作，不需要通过清空 DSH 数据来更新插件。
<!-- /readme-expansion -->

## 详细文档

[项目原说明](../README.md) · [第三方声明](../THIRD_PARTY_NOTICES.md) · [许可证](../LICENSE)

原有功能细节、配置、截图与验证记录保留在上述文档中，历史结论按其注明的版本理解。
