# 验证可见工作区中的 AI 双页操作归属

Type: task
Label: wayfinder:task
Mode: AFK
Status: open
Blocked by: 01, 02, 03
Map: [helpr 首版技术决策地图](../map.md)

## Question

前提：[真实网页的页面与输入证据](01-visible-page-control.md)、[独立停止证据](02-independent-stop.md)、[模型 API 接入条件](03-model-api-access.md)。

在已有页面与停止证据支持的候选承载方式中，实际模型服务和 AI 执行器能否明确绑定两个目标页面，并在并行探路时保持操作、观察、错误和回复的归属？

将候选 AI 执行器接入已验证的页面与停止机制，覆盖两页同时探索、用户切换查看、同 URL 页面、弹窗、一个任务出错或停止而另一个继续。每次 AI 操作使用明确的页面身份，不以当前活动标签页作为任务路由。

核对候选工具在实际宿主中的扩展、协议、重入和取消行为；已有 [并行调查](../../../docs/research/parallel-execution-feasibility.md)中的未知项不能直接当作支持保证。此处的自动停止实验不替代真人接管证据。

输出各组合的可用范围、具体失败点、资源表现及可重跑证据，为选型提供事实；不通过简单轮流执行来宣称支持两项并行。
