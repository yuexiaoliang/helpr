# 旧版界面参考边界

核查日期：2026-10-10（America/New_York）。本轮只读查看 flowpolit 的参考图和相关代码，未启动旧版服务或访问业务账号。

用户已明确选择“真实网页 + 对话浮窗”的呈现方式，目的是直接看见系统正在操作什么。这项选择不表示继承旧版任务模型、执行架构或其他产品假设。

## 已有内容与尚未成立的能力

| 参考项 | 代码或资料所能支持的结论 |
| --- | --- |
| 真实网页工作区 | 已有任务标签、地址栏、真实 HedgeDoc 页面及同窗口浮窗。页面与浮窗分别承载，隐藏浮窗不等于隐藏网页。 |
| 浮窗交互 | 真实网页浮窗可拖动、收起、隐藏与重新显示；内容包括目标、状态、单次填写按钮和操作记录，但没有对话输入框。 |
| 对话与执行控制 | 另一套模拟任务界面有对话输入和暂停、继续等控件；不能据此认为这些控制已接通真实网页任务。 |
| 人工接管与恢复 | 真实页面允许手动编辑，但没有完整的接管、重新观察当前状态与恢复执行实现。 |
| 视觉参考图 | 图中为知乎写作页面样式与任务浮窗，仓库称其为旧桌面视觉图。来源未明确，不能作为 flowpolit 已自动操作真实知乎的运行证据。 |

## 参考位置

- [真实网页工作区](/Users/yuexiaoliang/projects/flowpolit/apps/desktop/src/web-page/WebPageWorkspace.tsx:21)及[网页承载](/Users/yuexiaoliang/projects/flowpolit/apps/desktop/electron/web-page-host.ts:37)。
- [真实网页浮窗](/Users/yuexiaoliang/projects/flowpolit/apps/desktop/src/web-page/WebPagePanel.tsx:78)及[实际网页控制接口](/Users/yuexiaoliang/projects/flowpolit/apps/desktop/electron/web-page-api.ts:27)。
- [模拟任务浮窗](/Users/yuexiaoliang/projects/flowpolit/apps/desktop/src/features/TaskPanel.tsx:221)。
- [视觉参考图](/Users/yuexiaoliang/projects/flowpolit/docs/design/desktop-reference.png)及其[文档说明](/Users/yuexiaoliang/projects/flowpolit/docs/prototype.md:37)。

helpr 的对话、停止、人工接管、恢复与任务切换仍需按本轮需求独立设计和验证。已确认需求以 [产品访谈记录](../product/discovery.md)为准。
