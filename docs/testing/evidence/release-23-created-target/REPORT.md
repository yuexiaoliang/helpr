# 23阶段：创建后的动态目标身份和剩余工作恢复

2026-11-07，接续c1724b4。已完成创建前没有目标地址、POST后到达新编辑页的窄通用身份核对与持久化；事项23仍 **0/15**。本阶段不自动恢复表单新页写入，明确继续后的剩余字段动作有源码证据，实包没有脚本代答继续，也不冒称真人或自动跨页已通过。

## 产品行为

运行时 `targetCreation` 在创建点击前冻结已经观察到的唯一主文档文本框完整值和栏目；预留动作时拒绝字段不符、已有目标、发布批准、流程重放等不适用状态。它不携带结果URL，不使用WordPress／Drupal专用逻辑。

导航仍即时撤权并保存page-change暂停，原始navigation仅during-action。旧worker结束后沿用同target、加载完成和同站的result-page-ready；最多6秒／20次只读检查，两次观察URL／指纹／代次一致，全程保持同一native epoch并核对当前控制和会话。新页必须是先前未知的同站URL，同时具有唯一自身链接、唯一创建来源链接、原字段值和栏目。可靠保存 `ActionFact.discoveredTarget` 的source、binding、links、controls、evidence及target／draft事实引用后，原动作记为已核对，任务仍暂停。观察结果不证明导航因果，也不授予输入资格。

明确继续后，先核对新目标URL、字段和链接再规划剩余工作；不会重放创建点击。无检查点的创建仍未知，模型、普通resolve、准备事实及备份review不能将其改写为成功。停止、保存失败、原生epoch变化、错误target／代次、字段错配和链接缺失／重复均不放行。

格式26接续25，迁移前备份 `workspace-before-created-target-23-*`。冷开保留事实及暂停，导入真实备份保留restoreReview；坏字段和事实引用拒绝读取。创建后的结果未完成整个委托，因此保留原共享网站占用规则；没有独立账号／权限证据时不能从新目标URL推断同站任务可并行。

## 源码与候选

- 初始[14项定向](TARGETED-INITIAL.txt)通过；补充剩余字段发送和缺检查点恢复反例后，共16项新测试。第一次全量[363项中362通过](SOURCE-STALE-DIST.txt)，记录进程测试启动旧格式25的dist读取新格式26资料，报RECORDS_EXITED。重新[编译](COMPILE.txt)后，单次完整[363应用／17验证器／25旧回归及静态检查](SOURCE-FINAL.txt)全部通过。
- 后续只改4份验证器／测试文件，产品与应用测试未改；最终[17项验证器](VALIDATION-ISOLATED.txt)再次通过。没有把先前类型、lint、测试括号或旧dist失败删掉；完整[失败记录](SOURCE-FAILURES.md)与原始输出保留。
- [候选88 created-target-23](BUILD-88.json)，0.2.2／格式26，来源c1724b4加构建时精确未提交输入。构建后差异仅 `scripts/created-target-fixture.mjs`、`scripts/created-target-fixture.test.mjs`、`scripts/created-target-validation.mjs`、`scripts/validate-workspace.mjs`；按README复用适用候选，不改写其来源。
- [独立包预检](artifact-88/PREFLIGHT.json)：artifactVerified=true，54签名映像；退出2仍仅因4个依赖根许可证正文缺失，releaseAccepted=false。全包SHA-256：`1c5731654271d765e4962101c6e775aeeb7eb9428bdbd79981ad72ed9504b432`。[运行后独立复查](INDEPENDENT.json)确认完整包未变，并列出上述4份差异。

## 实包与独立证据

第一次布局失败[228](failed-228/result.json)：A身份通过，B因同站整站占用在派发前排队，50秒等待超时；57.295秒、1创建／2虚构规划。第二次布局失败[229](failed-229/result.json)：A通过，B第二origin被固定单origin隔离限制拒绝，未加载；18.205秒、1创建／1虚构规划。各自15PID／3组独立OS清空、租约释放。均不能算B反例，未放宽产品守卫。

最终采用两个**串行独立资料轮次**，每轮单一固定origin、一次POST创建及一次冷开；不抵算同站或产品并行验证：

| 案例 | 启动／时长 | 结果与证据 |
| --- | --- | --- |
| A，独立草稿A | 230／231，4.710秒 | POST后才生成随机编辑URL；自动只读保存target／draft和检查点，保持page-change暂停。冷开动作及事实不变，没有重建或新规划。[原始运行](case-A/RUNTIME.json) · [SQLite及OS独立核对](case-A/INDEPENDENT.json) |
| B，独立草稿B | 232／233，11.246秒 | 新页标题值故意不符；等待7秒后仍unknown/page-change，无discoveredTarget／准备事实。冷开不重发不规划。[原始运行](case-B/RUNTIME.json) · [SQLite及OS独立核对](case-B/INDEPENDENT.json) |

两轮各1次虚构规划、1次本机POST，均无脚本继续。分别SQLite格式26、quick_check=ok，快照／事实引用／网站创建回执独立一致；各24PID／6组清空，租约释放，stdout／stderr及空OS检查日志保留。A资料 `/private/tmp/helpr-workspace-validation-501/run-SanIiW`，原始运行 `.local/workspace-validation/run-1794022199793`；B资料 `/private/tmp/helpr-workspace-validation-501/run-vAORjx`，原始运行 `.local/workspace-validation/run-1794022220014`。

累计 **88构建／19测试安装／233启动／52故障／25清理**。本阶段含失败轮共4次本机创建、5次虚构规划，真实模型费用／远程写入／正式安装／系统权限变更均0。两次布局失败不重置旧计数。

## 未验与接续

本轮228–233启动分别4493／1003／1046／1012／987／958ms，不能覆盖此前5481／5749／5010／6869ms失败。无06完整原生切换、独立RSS或5分钟持续测量，性能未通过。CUA清单10秒超时，未取得窗口／真人新证据；21遗留IAB清理未知保持。

后续继续事项23的管理页动态结果链接发现和异步附件就绪。表单后的自动新页输入资格、空白创建、非完整AX字段、跨页流程重放及真实后台组合仍缺；不能套用anchorClick给form／redirect，也不能把本阶段有明确继续的源码模拟说成自动续行。创建已核对不表示整个委托完成，未知创建不得重建。无需新增24或仅总结审计。

17仍7/9、21仍1/8、22仍7/9；09旧范围不替代最终候选全量业务升级。真实业务 `release-23-real-business-v1` 授权持续有效、消费全0：须全部通用前置与本机组合通过、最终候选冻结、本人登录后才执行。DeepSeek/deepseek-flash，最多120请求／120万预留token／每次2048输出／90分钟；仅home既有WordPress38080／Drupal38081的helpr_tester，最多10附件／10新内容／10发布，不改删旧内容、账号或服务，不扩到额外并行／故障、正式安装或系统权限。集中本人步骤仍待准备，不重复申请同一授权。
