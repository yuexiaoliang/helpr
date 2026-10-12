# 恢复核对依据自动形成实验

一次性实验，已结束。对应[规划事项](../../issues/23-autonomous-recovery-evidence.md)，结论见 [REPORT.md](REPORT.md)。不是可交付产品。

在私有 Electron / Playwright 连接上，复用既有模型学得的运行时流程；通过 3 次真实模型提议补形成保存动作、稳定目标识别规则及恢复结果入口。冻结后使用新输入、新进程验证准备中断、回执丢失、结果核对后中断及最终派发间隙。不能确认时保留未知，不重新发布。

- [原计划](PLAN.md)、[准备次数修订](AMENDMENT-1.md)、[素材夹具修正](AMENDMENT-2.md)均保留。
- [额度记录](ledger.json)：24 次宿主启动、8 次准备、4 次上传、2 次发布、1 次外部修改夹具；模型 3 次、14,812 token。
- [冻结记录](freeze.json)、[自动形成的规则](rules.json)、[原始模型提议](artifacts/model)、[来源与原始文件摘要](evidence-index.json)。
- `engine.mjs` / `store.mjs` 是候选执行与记录接口；`broker.mjs` / `controller.mjs` / `host.cjs` / `worker.mjs` 是私有控制路径。
- `proxy.mjs` / `oracle.mjs` 是独立故障及预期核验装置，包含网站特定知识，候选不导入。`diagnostic*.mjs` 是明确保留的诊断夹具，不能当作恢复入口。
- 口令、cookie 和模型密钥不进入证据；`private/` 与每轮浏览器 profile 均忽略提交。

只读复核：

```sh
node .scratch/helpr-first-release/experiments/autonomous-recovery-evidence/verify.mjs
```

该入口只读取保存的证据、源码及 SQLite，不启动浏览器、不读取凭据、不调用模型或网站。原运行入口已封存；不能通过重置额度、覆写旧样本或重新执行发布来复现。需要新运行时另立有界计划。
