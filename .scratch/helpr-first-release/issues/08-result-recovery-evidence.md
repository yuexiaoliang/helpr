# 验证提交中断后的实际结果判定

Type: task
Label: wayfinder:task
Mode: AFK
Status: open
Blocked by: 05
Map: [helpr 首版技术决策地图](../map.md)

## Question

前提：[参数化流程的冷启动重放与修复更新](05-runtime-flow-replay.md)。

在提交前、提交请求已发出但回执丢失、结果已经存在等位置中断执行后，哪些运行时证据足以判定已完成、可继续或仍无法确定，从而避免重复发布？

复用已能运行的流程实验，用独立测试后台控制中断时机，重新打开页面并核对真实产出。记录恢复判断需要哪些执行记录、素材与目标关联，以及如何处理无法确认的情况。

核对两项任务处于不同进度时结果不会串用；已停止、待确认和人工接管的意图不能因进程重启被覆盖。测试环境可控制故障，产品侧核对方法须来自通用能力与运行时流程，不能固定为查询某个 WordPress 结果。

输出事实证据与最小记录要求，供持久化和恢复协议设计；区分页面或结果可重新观察，与运行中执行已经完整恢复这两种结论。

## Comments

2026-10-10：[流程重放实验](../experiments/runtime-flow-replay/REPORT.md#失败样本与修正) 已出现“发布成功，结果读取因重复链接报错”的真实样本，独立事后核对确认文章和附件均已存在。它可作为本事项的输入，不能直接当作提交中断恢复已通过；后续仍需控制中断位置并验证无重复发布。

2026-10-10：[分阶段检查的首次完整校准](../experiments/staged-workflow-checks/artifacts/staged/calibration/results.json) 又出现发布请求已发出、结果链接沿用旧标题而返回 `uncertain` 的样本。[只读位置校准](../experiments/staged-workflow-checks/artifacts/staged/result-position-calibration.json) 随后核实了该委托的公开产出，没有再次发布同一委托。它提供实际恢复材料，尚未验证进程中断、双任务记录归属或自动恢复策略。
