# 23阶段：动作窗口内导航证据

2026-11-07。本阶段补齐持久审计关联，尚未实现自动跨页续行或完成事项23。首个导航发生于动作观察窗口内，只记`during-action`，不能证明导航因果、新页面归属、动作成功或业务结果。

## 实现与边界

派发已可靠保存后、单步工作者启动前，宿主核对当前任务／执行／动作、页面target／代次和原生资格，登记最多16秒的观察窗口。首个导航消费窗口；原生epoch变化、已有阻断、能力不可用、过期、错误页面、旧代次、已结束／未登记窗口均不关联。子frame和同文档导航保留原属性，不借此放行。

宿主页面变化仍同步阻断原生门，控制通道的旧资格失效。暂停之后收到的事实可保存到同一已派发动作；不改变意图、状态、返回、结果、确认和执行权限。重复事实幂等、冲突拒绝。只记录首次导航，不把重定向终点改写成首次URL。没有模型可声明的导航授权字段，也没有站点专用规则或脚本代答继续。

格式23接续22并先备份，历史动作不补造导航；冷开和备份结构校验拒绝损坏关联。导航慢保存只进入单独的退出等待集合，不改变其它任务的系统派发资格；保存失败仍按现有记录故障逻辑收束。共享资格源码检查不抵算两项真实任务并行或原生输入因果验收。

## 证据索引

- `TYPECHECK-INITIAL.txt`及`TARGETED-INITIAL.txt`：首轮类型检查与37项专项／执行／备份检查通过。
- `NAVIGATION-ISOLATION-RED.txt`／`NAVIGATION-ISOLATION-GREEN.txt`：慢保存反例与修后7项通过；`SOURCE-FAILURES.md`保留lint、旧编译格式和集合隔离三项失败。
- `SOURCE-CHECK-BUILD81.txt`：重新编译后的328应用／14验证器／25旧回归和静态检查通过；随后追加的慢保存反例暴露原测试未覆盖的错误，不能用此前通过覆盖新失败。
- `BUILD-81.json`／`BUILD-81.txt`与`artifact/PREFLIGHT.json`：首次构建和独立预检保留；候选81因复查修正未启动。

- [最终源码检查](SOURCE-CHECK.txt)：329应用／14验证器／25旧回归，以及typecheck、lint、format全部通过。
- [候选82](BUILD-82.json)与[构建日志](BUILD-82.txt)：`action-navigation-audit-fixed-23`，版本0.2.2／格式23，54签名映像；源码来源为`b6a2ffd`加精确记录的未提交输入，不能用后续提交改写构建来源。完整包SHA-256为`151ea07ae21af6fcde48bfd45384117be364aafa504c1a619d1d70cb737c9f13`。
- [独立产物预检](artifact-82/PREFLIGHT.json)：`artifactVerified=true`，退出2仅因原4个根许可证正文缺失；`releaseAccepted=false`。
- [实包原始记录](RUNTIME.json)与[日志](RUNTIME-82.txt)：221／222两次启动共8.673秒，一次本机POST创建、303结果页，一次虚构规划。实际记录首次`/navigation-create`，不把`/navigation-result/1`重定向终点冒称首次导航；动作保持unknown、任务page-change暂停，冷开没有继续或重发。
- [独立SQLite与OS核对](INDEPENDENT.json)：资料`/private/tmp/helpr-workspace-validation-501/run-Gm8Isl`，格式23、quick_check为ok；SQLite关联与冷开快照一致；24个自有PID／6组均消失，租约释放。[PID空结果](OWNED-PIDS-AFTER.txt)与[进程组空结果](OWNED-GROUPS-AFTER.txt)保留。运行原始目录`.local/workspace-validation/run-1794017978157`，4份空stdout／stderr已按原名加`.txt`保留。

本轮未发生应用运行失败或复跑。启动前脚本曾因旧Python不提供`datetime.UTC`失败，尚未启动应用；改用`datetime.timezone.utc`后继续，见[PREFLIGHT-SCRIPT-FAILURE.txt](PREFLIGHT-SCRIPT-FAILURE.txt)。候选81仅构建未启动；两次构建和全部历史失败保留。累计82构建／19测试安装／222启动／52故障／25清理，本轮0真实模型费用、0远程写入、0正式安装、0系统权限变更。

两次startup为4921ms／1250ms，只是本轮启动样本，未按06完成原生切换、RSS和完整5分钟测量，性能保持未通过。前轮5481ms失败不能被此轮样本覆盖。

## 剩余工作与授权

下一阶段仍须完成持久导航检查点、动作因果与新页面归属的只读核对及停止竞争处理，才能考虑自动续行；不能把本阶段时间关联直接升级成许可。动态目标／结果、异步附件就绪、真实Excel／富文本与最终组合矩阵保持待验。23仍0/15，17为7/9、21为1/8、22为7/9；09旧范围不抵算最终候选完整资料升级。

真实批次`release-23-real-business-v1`的授权持续有效：120请求、1,200,000预留token，限现有WordPress／Drupal测试站点10附件／10新内容／10发布。消费全0；须通用跨页前置、本机组合、最终候选及本人登录就绪。无须再问已授予授权，也不能扩展到额外并行／故障批次、正式安装或系统权限。

本阶段没有新的CUA原生证据，21遗留IAB标签清理仍未知；进程退出不推定浏览器标签已关闭。原4根许可证正文仍缺；未完成06整套性能测量，前轮5481ms超门槛继续保留。当前不是可交付的最终候选。
