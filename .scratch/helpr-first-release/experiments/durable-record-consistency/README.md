# 持久记录与执行资格实验

本目录用于回答[验证持久记录与执行资格的中断一致性](../../issues/22-durable-record-consistency.md)，不是产品存储库。范围、预算与官方机制依据见 [PLAN](PLAN.md)，最终结果见 [REPORT](REPORT.md)。

`candidate.mjs` 是单一记录拥有者背后的实验 Module；`owner.mjs` 暴露与调用进程共用的 IPC 命令 Interface；`caller.mjs` 提供独立竞争进程；`sink.mjs` 独立记录每次本机请求与实际完成，不依靠候选的数据库或去重功能。

`run.mjs` 先冻结本轮源码，再执行中断、并发及故障场景。每轮单独保留 `manifest.json`、`summary.json`、逐项结果、进程日志、源代码、公开事实快照、SQLite 文件和独立效果账本。文件名及数据均为虚构内容，没有模型或网站凭据。辅助故障开关只属于实验，不进入产品 Interface。

从仓库根目录只读核对证据：

```sh
node .scratch/helpr-first-release/experiments/durable-record-consistency/verify.mjs
```

原运行入口为 `node .scratch/helpr-first-release/experiments/durable-record-consistency/run.mjs`，带 `--smoke` 只跑最小贯通场景。运行入口会消费 PLAN 中的一轮预算；六轮已经全部计入，不为查看报告再次执行，也不删除历史目录重置计数。需要扩展实验时另写具体范围与预算。

输入确认和流程候选的“已验证”条件由夹具显式提供，本轮只验证其保存、关联及竞争采用。接收端查询返回本机虚构结果，不代表系统已经能自动形成真实网站的恢复依据。SQLite 和文件同步配置、进程强杀结果与真实断电能力必须分开理解。
