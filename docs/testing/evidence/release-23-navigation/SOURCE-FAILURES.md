# 本阶段失败记录

1. `SOURCE-CHECK-INITIAL.txt`：新测试中的损坏记录使用未标注类型的JSON，lint报两项unsafe错误。补上精确结构类型，没有修改产品行为或测试断言。
2. `SOURCE-CHECK-STALE-DIST.txt`：328应用测试中327通过，进程清理恢复测试报`RECORDS_EXITED`。该测试的`open()`直接fork `dist/main/records.cjs`；源码夹具已创建格式23资料，但编译目录仍是格式22。`STALE-COMPILED-INPUT.txt`保留新迁移标记缺失的检查。重新构建后复验，未放宽格式白名单或测试断言。

`TARGETED-INITIAL.txt`中的37项专项及相关执行／备份检查、`TYPECHECK-INITIAL.txt`和独立导航夹具检查均通过。完整修后结果另见`SOURCE-CHECK.txt`。实包运行结果与失败按阶段报告记录，不覆盖本页原失败。

3. 候选81构建后复查发现，`recordNavigation()`使用系统级`interruptions`集合，会使其它任务的`systemReady()`暂时为false。`NAVIGATION-ISOLATION-RED.txt`保留慢保存反例；候选81未启动，不视为最终阶段候选。修正为独立的待保存集合，只参与退出／settled等待，另冻结候选82后再实包验证。

4. 启动前一次独立Python检查使用当前本机不支持的`datetime.UTC`，尚未启动应用即报AttributeError。`PREFLIGHT-SCRIPT-FAILURE.txt`保留说明；改为`datetime.timezone.utc`后前置检查通过。没有消费额外启动，也没有实包失败／复跑。

最终结果：修后329应用／14验证器／25旧回归与静态检查全部通过；候选82一次隔离运行通过，221／222两次启动。详细边界与清理见REPORT.md。
