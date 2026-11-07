# 23阶段：POST/303请求链归属与自动续行

2026-11-07，接续14b33ac。本阶段已实现并在实包核对通用POST/303新编辑页自动续行；事项23仍 **0/15**。不包含空白创建、富文本、跨页附件和流程复用，不代表真实后台或完整首版已通过。

## 产品行为

已冻结完整主文档AX字段的创建按钮，仍要求实际所属鼠标释放和首个formSubmissionPost/currentTab。独立只读CDP会话继续核对主文档Network请求：同一requestId、loaderId、frameId和session，首个POST、303转换GET、后续同站GET重定向，最多8跳，最终2xx响应、对应主frame提交和加载完成缺一不可。额外文档请求、脚本导航、跨站、片段、错误请求/loader/提交或加载失败均拒绝。首跳301/302/307/308不自动放行；不会将保留POST的重定向当作可续行的GET。请求可以是当前表单地址，但最终编辑目标仍必须是独立新地址；不含站点专用代码、POST正文、Cookie或响应正文记录。

宿主每次start/redirect仍立即撤权并通知持久暂停。另保留动作导航ID、target、恰好下一代、每跳URL和该次撤权前后epoch；控制侧保存与宿主暂停requestId关联的撤权回执。网络每跳与宿主事件须一一匹配，全部宿主/控制回执从原派发epoch连续且各恰好+1，重复、缺口、重叠、乱序或无归属回执都拒绝。不是读取当前epoch后放行，也不是按重定向次数容忍额外事件。普通链接仍保留原有两次撤权限制。

先等待旧worker结束，两次稳定观察保存discoveredTarget与target/draft事实，再复核同target、恰好下一代、最终URL、原会话、字段和已存指纹；可靠保存formNavigationResolution及两份链证据后才allow并排队。停止、接管、会话变化、保存竞争或保存后新输入继续阻断。原创建confirmed不重发，未知创建不让模型伪装成功。较早只读发现若因重定向失效，仅在完整网络链到齐后允许一次新的有界只读核对，不恢复输入。

格式30接续29，迁移先备份workspace-before-form-chain-23-*；保留旧直接POST历史，不补造新许可。冷开保持原动作，真实备份导入保留restoreReview；损坏链、引用、代次或原生回执拒绝。

## 源码证据

[完整基线](SOURCE-FINAL.txt)通过421应用/21验证器/25旧回归及typecheck、lint、format，先[compile](COMPILE-FINAL.txt)。之后补“POST到当前来源地址再303到新目标”及独立夹具：[最终67项定向](TARGETED-SAME-SOURCE.txt)、[22项验证器](VALIDATION-FINAL.txt)和[最终静态](STATIC-FINAL.txt)通过；没有把最后新增分支冒称已在前一421项全量中运行。最终仅验证器增加快照/原生追踪和非page-change暂停立即收束，另跑[22项验证器](VALIDATION-AFTER-TRACE.txt)。

反例覆盖无实际点击、其它任务、脚本/GET/子frame、新标签、跨站、片段、请求/loader/commit不符、错误状态、未完成加载、额外文档、回执缺口/重叠/乱序、错误target/跳转、缺宿主证据、保存失败、停止/原生/会话竞争、格式29迁移、冷开与真实备份。[失败记录](SOURCE-FAILURES.md)保留初始测试夹具引用错误和两项lint问题。前轮原生首次映像延迟本轮全量未复现，根因仍未解决。

## 固定候选与实包

[候选93 form-chain-23](BUILD-93.json)，应用0.2.2/格式30，54签名映像。构建来源14b33ac加构建时精确未提交输入，不事后改为本阶段提交。[独立预检](artifact-93/PREFLIGHT.json)artifactVerified=true，退出2仍仅因4根许可证正文缺失，releaseAccepted=false。整包SHA-256：`0d9f45f3b70b8b4b1f738123839c973deaba7d9962032e0bdc969121781625cc`。

首轮[240失败](failed-240/result.json)：65.311秒，1次规划/1次创建，无正文；等待自动续行超时，SQLite表明已进入takeover，旧动作unknown。缺少原生追踪，不能断言是真人还是其它输入来源，亦不能归因为网络链错误。13PID/3组独立清空，原包/资料保留。仅改验证器采集最后快照和本轮原生追踪、在非page-change暂停时立即收束；未修改产品、原生组件或守卫。

复用93的新隔离轮[241/242](RUNTIME.json)通过，31.712秒，7次虚构规划、3次创建、2次正文输入/网站保存，无脚本代答继续。三案顺序执行，不抵算产品并行：

- A：直接POST返回新编辑页，创建1次、保存身份后自动填写正文1次，实际观察确认完成。
- B：向当前表单地址POST后才生成随机编辑地址，经303/302到达；两次稳定目标观察及完整链保存后自动填写正文1次并完成。实际宿主3次和控制侧3次撤权回执交错到达，逐项连续覆盖epoch 1→7。
- C：合法POST/303/302后另由脚本重新导航到完全相同URL。最终目标身份confirmed但代次已为3，无formNavigationResolution，保持page-change暂停；0正文/0后续规划，等待7秒后仍不放行。
- 正常退出和冷开，三案原动作及完成/暂停状态保持，无新增创建、填写或规划。原生追踪A/B/C分别62/124/159行，无overflow或identified输入；只证明这次采样，不能解释首轮接管或替代真人因果验收。

[独立核验](INDEPENDENT.json)直接读取SQLite格式30/quick_check=ok、检查点、target/draft引用、网站收件和独立GET正文；原整站targetUrl:null占用保持。28自有PID/6组OS清空、租约释放，4份空stdout/stderr及OS日志保留。[核验脚本](VERIFY.py)不调用产品判定函数。原始目录`.local/workspace-validation/run-1794027937625`，资料`/private/tmp/helpr-workspace-validation-501/run-PMBjqc`。

构建后仅`scripts/form-navigation-validation.mjs`变化；[精确差异摘要](RETRY-INPUTS.json)和[运行后包/输入复核](VERIFY-BUNDLE.mjs)明确保留构建时/当前摘要，产品及整包不变，不把后改验证器冒称构建输入。首轮资料`/private/tmp/helpr-workspace-validation-501/run-RCKyoC`、原始目录`.local/workspace-validation/run-1794027703953`。

## 累计、未验与接续

累计 **93构建/19测试安装/242启动/52故障/25清理**。本阶段含失败轮合计4创建/2正文保存/8虚构规划；真实模型费用、远程业务写入、正式安装及系统权限操作全部0，已授权release-23-real-business-v1消费0。

240/241启动12807/10052ms新增超过5000ms失败，242为4052ms；旧5481/5749/5010/6869/5014/5023ms均保留。无06原生切换、独立RSS或完整5分钟，性能未通过。CUA仅一次getState、10秒超时，未取得窗口/真人新证据，21遗留IAB清理未知。磁盘约865MiB，下一构建前须处理空间准备，所有历史候选及90部分包保持。

下一阶段继续23的空白创建等通用前置，随后非完整AX/富文本、一般管理页、跨页附件及explicit-current-url跨页复用。已有创建/发布未知不重发，不放宽本阶段逐事件守卫；不得用这条路径抵算真实后台全部前置。17仍7/9、21仍1/8、22仍7/9，09旧范围不替代最终候选全量升级。真实批次须全部通用前置、本机组合、最终候选及本人登录齐备后执行，原限定授权持续有效无需重复申请。23仍0/15，不新增24、不推送。
