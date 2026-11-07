# 23阶段：直接POST新编辑页自动续行

2026-11-07，接续7f81668。本阶段实现直接POST创建后的自动续行，事项23仍 **0/15**。POST/303重定向链未取得自动续行许可，不代表真实WordPress／Drupal前置或完整首版已经通过。

## 产品行为

已冻结完整主文档AX字段的targetCreation按钮，实际所属鼠标释放发送后，Chromium首个主frame formSubmissionPost/currentTab请求可产生独立表单证明。请求只准同站、无片段且不同于来源URL；anchorClick、脚本、GET、子frame、新标签、其它任务输入、无冻结创建规则和截断观察均不进入此分支。

宿主仍立即撤权、保存page-change暂停。旧worker结束后，原动态创建路径先完成两次稳定观察，保存新目标、字段和target／draft事实。再次只读核对请求URL、同target、恰好下一代、原native epoch恰好+2、原会话、原字段与已存指纹，可靠保存独立formNavigationResolution后才允许新资格和后续规划。没有脚本代答“继续”，原创建不重派发；原navigation仍是during-action，不被改写为因果证明。

停止／接管、额外原生事件、会话变化、字段／指纹变化、保存失败及任何重定向均不放行，即使重定向最后回到相同POST地址。较新输入发生在保存之后仍再次暂停；协调状态须ready且无refreshRequired。没有独立账号／权限依据时，仍持有targetUrl:null的整站占用，不因发现草稿缩小占用。

格式29接续28，迁移前保留workspace-before-form-navigation-23-*。动作检查点进入冷开和真实备份；导入后仍restoreReview，坏epoch、代次、指纹、请求地址和缺目标拒绝，旧历史不补造表单许可。

当前只支持已填完整字段、无重定向的POST直接返回编辑页。POST/303链、空白创建、非完整AX／富文本、一般管理页、跨页附件及explicit-current-url跨页流程复用仍待实现或验证。原附件就绪的单页、唯一新增可下载链接边界继续保持。

## 源码验证与保留的失败

[完整冻结检查](SOURCE-FROZEN.txt)通过395应用／20验证器／25旧回归及typecheck、lint、format；含13项新增用例。格式变更后先[compile](COMPILE-FROZEN.txt)。定向覆盖实际续做正文、缺证明、错误请求、重定向、字段变化、原生与保存竞争、会话变化、冷开、格式28迁移和真实备份。

原会话测试两项注入缺失、lint多余非空断言均已修正，原输出与[失败说明](SOURCE-FAILURES.md)保留。第一次完整395应用为393通过、2项原生启动失败（NATIVE_EXIT_RECEIPT_TIMEOUT、DISTINCT_HOST_NOT_STARTED）；同一映像单独7项通过。[最小对照](NATIVE-PROBE.json)得到已有映像110ms、新生成映像首次3003ms超时、同一新映像第二次143ms，自有组清空。首次执行延迟得到局部复现，底层根因与第二项失败是否同源仍未确定，未修改原生代码、未放宽门槛。随后不重建、复用相同映像的完整检查通过；这不等于首次执行问题已经修复。

## 固定候选与实包

[候选92 form-navigation-23](BUILD-92.json)，应用0.2.2／格式29，54个签名映像。构建来源为7f81668加构建时精确未提交输入，不事后改写为本阶段提交。[独立预检](artifact-92/PREFLIGHT.json)artifactVerified=true，退出2仍仅因`@ai-sdk/provider-utils`、`client-only`、`drizzle-orm`、`saxes`四个根许可证正文缺失，releaseAccepted=false。全包SHA-256：`1f83bb86aaef7a63ae808444cce9658dd5845e9f6d25bf03d118289c2232bb80`。运行后再次核对所有构建输入和全包不变。

入口：`pnpm validate:workspace --fixture --candidate=form-navigation-23 --form-navigation`。[原始记录](RUNTIME.json)与[运行输出](RUNTIME-92.txt)：238／239两次启动，一轮18.435秒，4次虚构规划，无脚本代答继续。

- A：POST直接返回新编辑页。创建一次，字段与目标检查点可靠保存后自动规划、填写一次“自动续行正文”，网站收到一次正文保存。随后从实际观察确认并完成；独立GET正文一致。
- B：POST后303／302两次重定向回到完全相同的POST地址。新草稿身份核对成功，但表单输入许可不成立，保持confirmed创建＋page-change暂停；无正文输入或后续规划，等待超过6秒恢复上限后仍未放行。
- 正常退出与冷开后，原动作、A完成和B暂停保持；无新增创建、正文输入或模型规划。两案顺序执行，不抵算产品并行。

[独立核验](INDEPENDENT.json)直接读取SQLite格式29／quick_check=ok、原始动作、检查点与target／draft引用、网站收件和正文，不调用产品判定函数；核对A正文输入晚于新页核对，B重定向回原地址，未完成任务仍使用整站targetUrl:null占用。26个自有PID／6个进程组经OS确认清空，租约释放；4份空stdout／stderr与空OS日志原样保留。[核验脚本](VERIFY.py)及[运行后整包／输入核对](VERIFY-BUNDLE.mjs)可复查。原始目录`.local/workspace-validation/run-1794026089882`，隔离资料`/private/tmp/helpr-workspace-validation-501/run-mQQJ4i`。

## 累计、未验与交接

累计 **92构建／19测试安装／239启动／52故障／25清理**。本轮原生诊断只编译运行临时监督程序与Node，不是Electron启动或正式候选构建；单独保留证据。真实模型费用／远程业务／正式安装／系统权限全部0，已授权release-23-real-business-v1消费仍0。构建后磁盘约1.8GiB，后续构建先检查空间，保留所有旧候选及资料。

238启动 **5023ms** 新增超过5000ms失败，239为1520ms，不覆盖旧5481／5749／5010／6869／5014ms失败。原生新映像首次执行延迟仍未查清；无06原生切换、独立RSS与完整5分钟，性能未通过。CUA一次10秒清单超时，无窗口／真人新证据；21遗留IAB清理未知继续保留。

下一聊天继续23的POST/303重定向链通用归属与自动续行，必须逐事件区分受管表单链和额外导航／输入，不能把固定+2改成“读取当前epoch后放行”。随后按实际前置补空白创建、非完整AX／富文本、一般管理页和跨页流程复用。真实后台仅在全部通用前置、本机组合、最终候选与本人登录齐备后执行既有授权批次。17仍7/9、21仍1/8、22仍7/9；09原范围不替代最终候选全量升级；23仍0/15，不新增24、不推送。

提交前另加严一份测试的schema反例：使用合法source基线并先断言正例，确保坏epoch／代次／指纹等不是因额外字段提前失败。最终[40项定向](TARGETED-STRICT-BASELINE.txt)与[静态检查](STATIC-AFTER-TEST.txt)另行核对；原395项完整检查在这次纯测试调整前完成，未再重复全量。运行当时全包与全部输入不变的证据保留，随后仅`tests/workspace/created-target.test.ts`变化；[最终输入差异](FINAL-INPUTS.json)及[核验脚本](VERIFY-FINAL-INPUTS.mjs)明确记录旧／新摘要，产品、运行脚本和候选92保持不变。
