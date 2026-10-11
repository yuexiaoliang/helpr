# 自动归纳与条件校准实验

对应 [验证无需人工修订的流程归纳与条件校准](../../issues/15-autonomous-workflow-induction.md)。结论与证据见 [REPORT.md](REPORT.md)，实验边界见 [DESIGN.md](DESIGN.md)。完整流程没有学成；字段级正反条件和局部复用取得证据。

## 文件职责

- `runtime.mjs`：通用绑定、原文出处校验、页面操作、条件检查、固定输入与动作记录检查；不包含后台名称或文章字段知识。
- `prompts.mjs`：探索、条件及归纳的实验指令。模型原始回复另存，程序不人工修补候选。
- `fixtures.mjs`：测试网站、明确的实验授权、虚构文本与素材，以及独立结果断言和故障注入。
- `run.mjs`：有预算的真实探索、有限校准和候选实验入口。完整探索未成功，`compile`、`evaluate` 阶段尚未运行。
- `probes.mjs`：工具调用输出形式和相近委托的只读对照，不执行网页动作。
- `condition-probe.mjs`：基于本轮实际失败阶段，提议字段观察位置，并验证真实填写前后状态、保留集和控件更名。
- `integrity-probe.mjs`：借用旧实验候选的离线约束回归，不能算本轮自动学习成功。
- `summarize.mjs`：从实际结果生成证据索引和用量汇总。

## 运行条件

需要 Node.js、Playwright、已有隔离测试后台、相邻模型实验的配置与被忽略的 `.env.local`，以及流程重放实验被忽略的作者登录态。不要在日志、命令或报告中写入 Key、Cookie 或口令。

```bash
npm install --ignore-scripts --no-audit --no-fund
node run.mjs artifacts/new-run learn
```

使用原生工具调用，并在新的虚构任务上尝试本轮已核对前缀：

```bash
node run.mjs artifacts/new-native-run learn artifacts/attempt-d native
```

这些命令会在测试网站新建编辑记录，若探索继续成功，也可能上传或发布虚构内容；仅可用于已授权的隔离测试站点。现存 `attempt-*` 目录保留原始证据，不应覆盖。各阶段以结果文件中的 `status` 和独立断言判断结果，不把进程正常结束当作任务成功。

补充探针使用固定证据目录；重新运行前应复制本目录或给脚本改用新的输出目录，避免覆盖原始证据。原始实验使用的具体输入、模型回复、局部失败、源码摘要都在 `artifacts/`。

以下两项不操作网站或调用模型，可核对离线规则与重新汇总已有记录：

```bash
node integrity-probe.mjs
node summarize.mjs
```

所有预算均为实验限制，不是用户的产品发布约定。无完整候选时，不能让待实现的完整复用、上传反例、实际发布核对或修复阶段被当作“已通过”。
