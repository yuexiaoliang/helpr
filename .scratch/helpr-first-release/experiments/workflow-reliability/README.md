# 流程适用性、步骤条件与修复约束实验

本目录是 [验证流程适用性、步骤条件与修复边界](../../issues/14-workflow-reliability-contract.md) 的一次性实验。它用于检验候选约定，不是 helpr 产品实现，也没有确定最终浏览器或模型执行组合。

候选依据见 [DESIGN.md](DESIGN.md)。失败提议、失败运行及最终对照都保留在 `artifacts/`，结果与限制见 [REPORT.md](REPORT.md)。

## 分工

- `contract.mjs`：显式参数引用、类型与适用性检查、任务授权摘要和素材摘要校验、修复字段限制。没有网站名称、栏目或文章字段知识。
- `executor.mjs`：绑定页面上的通用操作、步骤与提交条件、实际结果检查。操作前核对执行状态，结果不确定时不自动重跑。
- `compile.mjs`、`revise.mjs`、`focus-checks.mjs`：三种候选归纳尝试，调用真实 `deepseek-flash`，分别保留输入、原始输出、组合修正及模型用量。最后一种由实验驱动把分项提议组合回已有路径，不能算无人修订的通用流程归纳。
- `collect-evidence.mjs`：复用先前 AI 学到的步骤，截住真实上传请求，观察上传前后差异；此准备过程不点击发布。可把候选提交条件放到同一真实页面的两种状态上对照。
- `run.mjs`：虚构测试任务、明确标记的实验授权、页面故障注入，以及调用公共执行 Interface 的测试驱动。独立核对复用原实验的 `verifyPublication`，不把人工编写的测试断言作为运行时成功规则。

## 运行

需要已运行的独立 WordPress 验证后台、Node.js、相邻模型实验中的本机配置与被忽略的凭据文件，以及原流程实验中被忽略的作者登录态。既有凭据失效时通过原准备流程更新；不要将 Key、Cookie 或口令放进命令或报告。

```bash
npm install --ignore-scripts
```

复用最终候选执行一组测试时，请使用全新的输出目录，以保留旧证据和避免混淆真实文章：

```bash
node run.mjs artifacts/focused-bound-candidate/candidate.json artifacts/my-positive-run baseline,repeat,literal-collision,delayed-upload,repair-safe,updated
node run.mjs artifacts/focused-bound-candidate/candidate.json artifacts/my-negative-run wrong-flow,unauthorized-target,material-changed,duplicate-control,changed-content,changed-target-state,repair-unsafe,repair-wrong-step,stopped
node collect-evidence.mjs artifacts/my-condition-check artifacts/focused-bound-candidate/candidate.json
```

这些命令会创建真实测试草稿、附件及文章。不是对中断任务的恢复，也不应用于业务站点。普通成功路径和大部分反例不读取模型 Key；`repair-safe` 与 `repair-unsafe` 调用真实模型提出修复。后者会要求模型生成故意试图删除结果检查的无效提议，只用于验证程序拒绝它。

`repair-wrong-step` 使用已保存的真实模型定位提议，将步骤标识改为另一条步骤以检验拒绝规则；它不重新调用模型，依赖本目录已有的 `artifacts/repair-retry/repair-safe/model-repair.json`。

每个场景启动独立浏览器与上下文。`repair-safe` 完成且独立核对通过后，后续 `updated` 使用保存的新候选数据，在同样的控件改名下执行；该阶段不再调用模型。跨 Node 进程的复用另已有前一个实验的证据，此处不重复声称。

## 必须保留的证据边界

任务类型、输入槽位和实验授权由测试驱动提供。最终候选中的标题定位、上传观察位置和确认控件来自真实模型提议；素材期望值强制绑定任务输入，并且有实验驱动组合规则。此处没有验证任意自然语言委托的无人介入归纳、网站泛化、人工预览流程或产品级流程选择。

`visible` 条件表示至少一个匹配对象可见；读取值和执行写操作仍要求唯一。最终结果链接可以有多个展示入口，但必须指向同一个获准站点 URL。输入内容、类别及下载哈希由运行时结果条件分别检查。

本实验的动作效果分类也是候选数据；不能靠它保证识别任意网站所有副作用。停止信号检查不替代已发浏览器调用的取消验证。中断后的实际结果判定、并行归属与人工接管、素材预览版本关联、第二后台分别继续使用已有事项验证。
