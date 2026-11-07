# 23阶段：可核对正文的富文本输入

2026-11-07，接续2f7e06d。本阶段实现主文档富文本的受控输入、完整正文观察与独立核对，最终候选98。**已有段落编辑器的精确换行写入仍未解决**：Chromium可能把单换行插入为两个段落的双换行，此时保持未知并暂停，不把多余空行当成功。事项23仍0/15，不抵算完整真实后台业务。

## 实现边界

只支持主文档中唯一精确命名的AX textbox、显式contenteditable根及可完整核对的普通文字结构。非空正文来自Chromium AX完整值，并与DOM文字序列交叉核对（只容许结构换行差异，不自行推算段落换行）。AX缺值时，仅完整、无文字且无BR/P/DIV子节点的单一空结构可补空；真实AX换行原样保留。隐藏内容、嵌套编辑区、复杂嵌入、子frame及无AX角色/名称仍拒绝。

沿用受限Playwright fill、原生输入门、会话及停止守卫，最多4000字符纯文本，不插入HTML或承诺保留格式。工作者再次检查实际节点是否contenteditable，必须与已核对标记一致，防止模糊名称、层级或其它frame绕过；原协议能力列表不扩大。源控件在派发前可靠保存，输入后独立观察同一页面唯一字段，**实际全文精确等于动作值**才确认。DOM与AX交叉核对允许结构换行差异，并不放宽最终动作值比较。

格式32接续31，先备份workspace-before-rich-text-23-*。richTextSource/richTextResult保存实际控件，冷开和备份校验来源及正文；旧备份导入仍restoreReview，模型review不能确认未明输入。新增核对拒绝归入可保存的业务暂停；记录保存故障、原生/会话/导航守卫、旧创建非空字段、只读身份和资源占用规则不变。

## 源码检查与失败

[完整基线](SOURCE-FINAL.txt)通过473应用/24验证器/25旧回归及typecheck/lint/format，对应首次实包前版本。实包发现错误分类遗漏后，[67项定向](SOURCE-CHECKED.txt)、[24验证器](VALIDATORS-CHECKED.txt)及静态通过。再收紧缺AX的BR空值证明，最终[重新编译](COMPILE-EMPTY-GUARD.txt)、[122项定向](SOURCE-EMPTY-GUARD.txt)及[类型](TYPECHECK-EMPTY-GUARD.txt)/[lint](LINT-EMPTY-GUARD.txt)/[格式](FORMAT-EMPTY-GUARD.txt)通过。最终定向包含27项富文本用例、旧空textarea、执行、备份及创建目标回归；没有冒称473全套已包含后续两项修正。

[失败记录](SOURCE-FAILURES.md)保留新测试预期/表名错误、编辑期间的混合版本检查失败和新测试lint错误。实际249超时、候选96原包及日志保留。真实收件驱动[SERVICE-RED](SERVICE-RED.txt)/[SERVICE-GREEN](SERVICE-GREEN.txt)：富文本不符已拒绝确认，但错误分类遗漏触发disable，留下running；修后保存paused，动作仍unknown且不重填。[实际AX/DOM样本](../../../../tests/workspace/fixtures/rich-text-observation.json)派生[BR-RED](BR-RED.txt)/[BR-GREEN](BR-GREEN.txt)，保证AX缺值且含换行结构时不补空。无临时调试日志。

97的250–253已通过对应两轮，原始证据保留[candidate-97](candidate-97/INDEPENDENT.json)及[段落轮](candidate-97/paragraph/INDEPENDENT.json)，不能冒称包含随后BR空值修正。

## 最终候选与实包

[候选98](BUILD-98.json) `rich-text-empty-guard-23`，0.2.2/格式32，54签名映像；来源2f7e06d加构建时精确未提交输入，不事后替换为本阶段提交。[包预检](artifact-98/PREFLIGHT.json)artifactVerified=true，退出2仍仅4根许可证正文缺失（@ai-sdk/provider-utils、client-only、drizzle-orm、saxes），releaseAccepted=false。全包SHA-256：`32d5edbd71a7563b40f58de5b12c3a72b331022ea3c405e72636ba05403ef7c9`。两轮后[独立重查](VERIFY-BUNDLE.mjs)确认全部构建输入和整包未变。

默认入口`pnpm validate:workspace --fixture --candidate=rich-text-empty-guard-23 --rich-text`：254/255，19.076秒、4次虚构规划、2次填入。

- A：真正空编辑根，AX省略value而完整DOM证明无正文；fill后完整中文、单换行、尖括号与&实际相符，HTML中尖括号被作为文字转义。源空值证明、结果AX全文与网站收件一致，确认完成。
- B：源非空正文为两个段落，AX实际双换行保留；本次填写另一份单行文字，网站将它改写为其它正文。模型仍声称完成，产品保持unknown/paused，无richTextResult，不重填。

独立入口追加`--rich-text-paragraph`：256/257，11.228秒、2次虚构规划、1次填入。保留249的原占位`<p><br>`，AX源值为换行；Chromium将单换行写为双换行，产品精确比较后保持unknown/paused，冷开不重填。此通过证明拒绝和暂停已修正，不证明该编辑器能正确保持输入换行。

两轮都正常退出及冷开，动作和完成/暂停状态不变，没有新增规划或填入；三案是串行独立检查，不抵算产品并行。原始运行分别`.local/workspace-validation/run-1794032780417`、`run-1794032839213`，隔离资料分别`/private/tmp/helpr-workspace-validation-501/run-Ud9Gn9`、`run-0nKRY0`。

[独立核对](INDEPENDENT.json)和[段落独立核对](paragraph/INDEPENDENT.json)直接读取SQLite格式32/quick_check=ok、源DOM编辑根/AX实际值、冻结源/结果、网页收件与独立GET正文、冷开记录。第一轮26PID/6组、第二轮24PID/6组均由OS确认清空，共享租约释放；8份空stdout/stderr及OS日志保留。[核验代码](VERIFY.py)不调用产品判定函数。

## 用量与后续

累计 **98构建/19测试安装/257启动/52故障/25清理**。本阶段三个候选、9次启动，实包共7次填入、14次虚构规划；最终98为3次填入/6次规划。真实模型费用、远程业务、正式安装和系统权限变化全0；release-23-real-business-v1已有授权消费0。所有旧候选与资料保留，没有本轮缓存清理。

249/250/254启动分别9239/8711/8452ms，新增超过5000ms门槛的失败；其它冷开/同包启动通过不抵消。旧全部性能失败、首次原生映像延迟根因保持，无06原生切换/RSS/完整5分钟证据，性能未通过。CUA一次10秒超时已收束，无窗口或真人新证据；21遗留IAB清理未知保持。

下一阶段优先解决已有段落富文本的通用受控换行输入，不删除真实反例、不归一正文掩盖差异；继续推进受管子frame/非完整AX或无名称编辑器。无只读身份的空白创建、一般管理页、跨页附件和explicit-current-url跨页复用仍缺。17仍7/9、21仍1/8、22仍7/9；09旧范围不替代最终候选全量升级。全部通用前置、本机组合、最终候选和本人登录齐备后才消耗已授权真实批次，不重复申请同一授权。23仍0/15，不新增24、不推送。
