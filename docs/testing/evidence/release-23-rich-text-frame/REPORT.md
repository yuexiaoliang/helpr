# 23阶段：受管同站子 frame 富文本

2026-11-07，接续7a1cfe2。实现同一受管页面内唯一同站HTTP(S)子frame的普通富文本观察与受控输入。事项23仍0/15，不代表WordPress/Drupal或整体交付通过。

## 实现边界

在同一次DOMSnapshot中核对frameId、URL、AX根的frameId，沿contentDocumentIndex逐层追溯到主文档可见IFRAME；重复URL/身份、父归属缺失、隐藏/受保护祖先、sandbox、跨站和快照缺失拒绝。观察前后完整frame tree必须一致。显式contenteditable的BODY可作为普通编辑根，仍要求唯一精确命名AX textbox与完整普通结构；非空值来自AX并与DOM文字交叉核对，不推算段落换行。子frame的原生空值补足未随之扩展。

输入继续固定ElementHandle，首行fill后受控软换行与文字输入。每段后控制拥有者重新观察并核对原backend节点、页面、会话及精确全文前缀；子文档除activeElement外必须实际持有焦点。原生、协议、资格、停止和接管守卫保持，最终全文逐字核对，格式32不变，无新CDP能力。验证观察入口可指定frameId，先在同一观察资格读取所属frame tree，仍只调用已有受管AX读取。

不支持无AX角色/名称、about:blank/srcdoc、任意跨站/跨进程编辑器、复杂嵌入或保留排版；最多4000字符/32非空行，CR及首尾/连续空行仍派发前拒绝。创建身份、上传和发布规则未变；不能把本项解释为允许未知创建或自动发布。

## 检查与失败

[完整检查](SOURCE-FINAL.txt)通过521应用/26验证器/25旧回归及typecheck/lint/format，应用套件277.03秒。此后仅修改模型提示文字与README，明确已核对子frame及必须使用实际frameUrl；[最终64项定向](TARGETED-FINAL.txt)和[格式](FORMAT-FINAL.txt)通过，行为代码与完整基线相同。初版69定向及新测试类型标注失败分别保留，详见[失败边界](SOURCE-FAILURES.md)。没有编辑运行中的源码检查，也不把脚本或源码测试充抵真人证据。

## 候选和实包

[候选101](BUILD-101.json) `rich-text-frame-23`，0.2.2/格式32、54签名映像；来源7a1cfe2加构建时精确未提交输入，不事后改写提交来源。[预检](artifact-101/PREFLIGHT.json)artifactVerified=true，退出2仍只因4根许可证正文缺失（@ai-sdk/provider-utils、client-only、drizzle-orm、saxes），releaseAccepted=false。整包SHA-256：`57b977b1e9ca054fde8b768f7d40d2046878a22de86bf20a02a5f086b73ac207`。

首次267在15秒就绪门槛停止，16.925秒收束，0任务/规划/输入；记录ready约13.27秒、host约15.06秒、controller约15.09秒。11PID/3组清空，原始证据及诊断保留[failed-267](failed-267/result.json)，资料`run-IE22xS`。按已有新映像首次延迟线索，仅一次同候选、不变15秒门槛、新资料复跑，且不并发CUA；后续就绪不抵消首次失败，不证明底层根因或性能修复。

实包入口 `pnpm validate:workspace --fixture --candidate=rich-text-frame-23 --rich-text-lines=<模式>`：

| 模式 | 启动 | 结果 | 输入事件/虚构规划 | PID/组 |
| --- | --- | --- | --- | --- |
| [frame-success](success/INDEPENDENT.json) | 268/269 | E空DIV、C已有两段的BODY，分别精确写入2/3行，confirmed/complete | 8/4 | 26/6 |
| [frame-replace](replace/INDEPENDENT.json) | 270/271 | 首行后同URL替换IFRAME，只1次输入；新AX frameId，宿主记录非主文档during-action、代次+1并撤权，unknown/page-change暂停 | 1/1 | 24/6 |
| [frame-focus](focus/INDEPENDENT.json) | 272/273 | 首行后焦点移到外层INPUT，子文档activeElement不足以放行；外层仍空，unknown/paused | 1/1 | 24/6 |

三轮17.409/14.863/13.019秒，都正常退出和冷开不新增输入或规划，动作事实保持。成功样本保留中文、尖括号、&和单LF；C源AX双LF原样保存，没有归一来源或最终正文。两种反例均无richTextResult；R导航只作为时间关联及暂停依据，不形成自动续写许可。

[独立核验](VERIFY.py)直接读取SQLite格式32/quick_check、源frame DOM归属/AX根/原backend节点、每次收件、GET与最终AX，不调用产品判定函数。核验脚本三处旧样本/空值假设错误保留在失败说明，修后重查同一原始资料，不重跑应用或修改候选。最终三轮全部经同一版核验器通过，74PID/18组OS确认清空；加首次失败共85PID/21组，租约释放。14份空stdout/stderr及空OS日志保留。[包重查](VERIFY-BUNDLE.mjs)确认三轮后全部构建输入和整包不变。

原始运行：`.local/workspace-validation/run-1794035514691`、`run-1794035543814`、`run-1794035602393`；隔离资料：`/private/tmp/helpr-workspace-validation-501/run-zEra2a`、`run-nJPewD`、`run-wC2ZfW`。失败267为`run-1794035429149` / `run-IE22xS`。全部保留，无本轮缓存清理。

## 用量与交接

累计 **101构建/19测试安装/273启动/52故障/25清理**。本阶段1候选/7启动/4整体填写/6虚构规划/10网站输入事件/0发布。真实模型费用、远程业务、正式安装、系统权限变化0，release-23-real-business-v1已有授权消费0。

267新增就绪超时；268–273启动4283/4132/4131/4276/3272/3563ms不能抵消旧性能失败。无06原生切换/RSS/完整5分钟，性能未通过。本轮CUA getState在10秒超时并已收束，未取得窗口或真人证据；上一阶段清单成功不等于本轮连接成功。没有选择或新启动额外应用/标签，21旧IAB清理未知保持。

下一阶段继续无AX角色/名称、about:blank/srcdoc等实际编辑器通用前置，不能猜字段或加网站专用分支。空行/CR及32非空行限制保持。无只读身份空白创建、一般管理页、跨页附件和explicit-current-url跨页复用仍缺；17仍7/9、21仍1/8、22仍7/9，09旧范围不替代最终候选全量升级。全部通用前置、本机组合、最终候选冻结及本人登录齐备后才消耗既有真实业务限定授权，不重复申请。23仍0/15，不新增24，不推送。
