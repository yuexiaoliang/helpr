# 23阶段：已有段落的精确单换行输入

2026-11-07，接续0c4e3a6。原249的`<p><br>`反例现在可通过受控键盘输入写入精确单换行；没有删除样本、改变CSS或归一最终全文。最终候选100在真正空根、占位段落和已有两段正文三个样本通过。**这不是任意富文本或整体交付通过，事项23仍0/15。**

## 实现与边界

保留上一阶段的主文档、唯一精确命名AX textbox、显式contenteditable和完整普通文字结构。首次fill仅替换首行，后续使用Playwright Shift+Enter和insertText；不以网页脚本写innerHTML/textContent。固定同一ElementHandle，每步只读核对实际节点、可编辑状态、焦点、折叠光标和尾部。软换行后须是精确前缀加换行，末尾只能有明确的单个占位BR或文字LF；该临时状态不作为最终成功。

每段文字输入后，控制拥有者通过原受管DOM/AX观察重新检查页面地址、target/generation、会话、原backendNodeId、完整控件和精确全文前缀，顺序回执后才允许下一段。原资格和原生门仍检查每条输入协议；停止、接管撤权、迟到观察、替换、焦点或正文变化均不能放行。总动作仍限16秒，没有输入重试。最终动作事实仍由既有完整AX全文逐字比较保存，模型不能确认未知结果。格式32不变，无新增迁移或协议能力。

当前多步输入限32个非空行、4000字符；CR、首尾/连续空行派发前拒绝，不擅自删改正文。单行、原生字段和最终结果规则保留。子frame、无AX角色/名称、复杂嵌入及保留排版仍不支持。中途失败保留整个动作unknown，不把部分输入当完成；记录保存、创建身份、导航链、会话和资源守卫不变。

## 源码与失败

[完整基线](SOURCE-FINAL.txt)：498应用、25验证器、25旧回归及typecheck/lint/format通过，应用套件262.18秒。它发生在后续两项边界增补之前，不冒称覆盖最终所有代码。

[软换行改写红例](BREAK-RED.txt)暴露追加下一行前未核对换行后的正文。修后[76定向](TARGETED-FINAL.txt)、静态及[25验证器](VALIDATORS-FINAL.txt)通过；另补会话变化[10项](SESSION-FINAL.txt)。实包258发现文字LF占位，再经[LF红例](LF-RED.txt)与[最终78定向](LF-GREEN.txt)、[类型](TYPECHECK-LF.txt)/[lint](LINT-LF.txt)/[格式](FORMAT-LF.txt)通过后重新构建。最终78包括工作者检查、控制拥有者回执、真实记录层富文本、执行与原协议门回归，没有再次全跑501项。

[失败记录](SOURCE-FAILURES.md)保留旧双换行回放、测试样本缺字段、lint错误、BREAK/LF红例及实包258。候选99/258在真正空根写完首行后，Chromium在pre-wrap下产生文字LF/LF占位，原守卫正确暂停且未写第二行；1整体填写/1规划/2输入事件，9422ms启动失败。原包、[运行](failed-258/result.json)、空stdout/stderr和[OS清理](failed-258/OS.json)保留，13PID/3组清空。

## 最终候选与实包

[候选100](BUILD-100.json) `rich-text-lf-23`，0.2.2/格式32、54签名映像。来源0c4e3a6加构建时精确未提交输入，不事后替换为本阶段提交。[预检](artifact-100/PREFLIGHT.json)artifactVerified=true；退出2仍仅4根许可证正文缺失（@ai-sdk/provider-utils、client-only、drizzle-orm、saxes），releaseAccepted=false。整包SHA-256：`79e8a3009eceb4ac721b9f294b0e2824a59b7b348f93fafbd3237776d0c33b84`。

入口`pnpm validate:workspace --fixture --candidate=rich-text-lf-23 --rich-text-lines=<模式>`，四轮独立隔离资料、正常退出和冷开；不是产品并行验证。

| 模式 | 启动 | 实际结果 | 输入事件 / 虚构规划 | 自有PID / 组 |
| --- | --- | --- | --- | --- |
| [success](success/INDEPENDENT.json) | 259/260 | E真正空根、A原占位P/BR、C已有两段替换为三行，全文逐字正确，confirmed/complete | 11 / 6 | 28 / 6 |
| [rewrite](rewrite/INDEPENDENT.json) | 261/262 | 网站改写首段后unknown/paused，不继续、不重填 | 1 / 1 | 24 / 6 |
| [focus](focus/INDEPENDENT.json) | 263/264 | 首段后焦点转移，unknown/paused，另一个字段仍为空 | 1 / 1 | 24 / 6 |
| [stop](stop/INDEPENDENT.json) | 265/266 | 收到24行目标的首行后从共用业务入口停止，26ms取得回执；之后0输入，保持stopped/unknown | 1 / 1 | 24 / 6 |

E保留缺AX值+完整空DOM来源；A源AX真实值为LF；C源AX双换行原样保留。成功时每段收件与完整前缀逐字相符，软换行事件为insertLineBreak，完整中文、尖括号和&作为纯文本保留。三种拒绝/中断都不产生richTextResult。四轮冷开全部不新增规划/输入，动作事实保持。

[VERIFY.py](VERIFY.py)独立读取SQLite格式32/quick_check=ok、源DOM/AX、动作事实、网站每次收件、独立GET和最终AX，不调用产品判定函数。各轮100PID/24组全部由OS核对清空，租约释放；16份空stdout/stderr与原始日志保留。[VERIFY-BUNDLE.mjs](VERIFY-BUNDLE.mjs)分别确认每轮后所有构建输入和整包未变。

原始运行：`.local/workspace-validation/run-1794034300118`、`run-1794034332422`、`run-1794034367601`、`run-1794034397774`。资料：`/private/tmp/helpr-workspace-validation-501/run-n5FvEK`、`run-vmUH09`、`run-34az79`、`run-rTDtJY`。失败258为`run-1794034101862` / `run-hIGC5z`。全部保留。

## 用量与交接

累计 **100构建/19测试安装/266启动/52故障/25清理**。本阶段两个候选、9启动、7整体填写、10虚构规划、16网站输入事件、0发布；最终100为6整体填写/9规划/14输入事件。真实模型费用、远程业务、正式安装、系统权限变化0，release-23-real-business-v1既有授权消费0，无本轮缓存清理。

258/259启动9422/7956ms新增超过5000ms失败；其它约2–3秒启动不抵消旧失败，无06原生切换/RSS/完整5分钟，性能未通过。CUA getState本轮约2.94秒恢复返回清单，但未取得helpr窗口/输入证据；不能沿用旧“本轮连接超时”，也不能由清单恢复声称真人接管通过。没有新标签页，21遗留IAB清理未知保持。

下一阶段继续受管子frame及无AX角色/名称等实际编辑器前置；本阶段空行/CR和32行限制须明确保留，扩展时另做受控输入与原样全文验证。无只读身份空白创建、一般管理页、跨页附件和explicit-current-url跨页复用仍缺。17仍7/9、21仍1/8、22仍7/9，09旧范围不替代最终候选全量升级。既有真实业务限定批次授权持续有效，待全部通用前置、本机组合、最终候选和本人登录齐备后才消耗；不重复询问同一授权。23仍0/15，不新增24，不推送。
