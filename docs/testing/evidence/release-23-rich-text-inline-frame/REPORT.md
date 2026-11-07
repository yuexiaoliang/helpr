# 23阶段：继承来源的内联子文档富文本

2026-11-07，接续cce402d。支持唯一about:blank / about:srcdoc子文档中的精确命名textbox普通富文本输入；**事项23仍0/15**，不是WordPress/Drupal、完整发布或整体交付通过。

## 实现与边界

沿用完整frame tree、DOMSnapshot的frameId/URL、AX根及逐层可见IFRAME/contentDocumentIndex归属。新增私有宿主frame-origins只读请求：核对task/target/generation后读取WebFrameMain的实际origin、URL、frameTreeNodeId、frameToken、processId、父节点和detached；同一观察资格前后原生事实必须完全一致，各层实际来源均等于主HTTP(S)网站。内联CDP securityOrigin可为实际同站来源或`://`，后者本身不授予许可。重复URL/身份、opaque/null来源、错误父归属、sandbox、隐藏/保护祖先、快照缺失均拒绝。

blank的父IFRAME须无srcdoc且src缺省、空或精确about:blank；srcdoc须存在srcdoc属性。不把baseURL或网页声明当来源，不从URL猜继承关系。主网站URL策略不扩大；内联文档只提供已证明富文本控件，不补原生字段和结果链接。没有新增CDP能力或网页脚本输入路径，宿主只读元数据不需要系统授权，格式32不变。

工作者继续固定同一节点，首行fill后受控软换行与insertText，逐段检查原backend/target/generation/session、实际焦点和精确前缀，最终全文逐字核对。16秒动作截止、无重试、最多4000字符/32非空行、CR及首尾/连续空行拒绝均保持。无AX角色/名称、重复frame URL、复杂编辑器及保留格式仍缺。publication.fields和流程学习/修复仍有HTTP(S)/同站URL约束，本阶段没有宣称内联编辑器已能完成完整发布或复用。

## 源码、原始失败与修正

[初版完整检查](SOURCE-FINAL.txt)为540应用/27验证器/25旧回归及静态通过，应用263.49秒；其后仅修夹具初始化方式，再冻结102。父文档调用document.open会改变子文档URL，故blank夹具使用网站自身初始化DOM及事件监听，产品输入仍经受管Playwright。该准备调整发生在首次运行前，不虚构成实际失败。

[102/274](failed-274/result.json)在10.575秒暂停：实际DOM/AX已生成编辑根，但CDP来源为`://`，初版错误地把该字段当作真实origin，因而没有提供richText。1次失败虚构请求、0动作/0输入，13PID/3组清空，启动8714ms超过5000ms。原样快照回放[ORIGIN-RED](ORIGIN-RED.txt)保留；修为额外宿主原生来源证明，缺该证明仍拒绝。42项定向通过后重新编译并[完整检查](SOURCE-ORIGIN-FINAL.txt)：**550应用/27验证器/25旧回归与typecheck/lint/format通过**，应用271.65秒。新包实际原生读数确认blank/srcdoc继承网站来源，不把契约夹具冒称274真实来源证据。

[103/275](failed-275/result.json)在第一次准备DOM观察遇OBSERVATION_NOT_AUTHORIZED，15.582秒收束，0模型/动作/输入；启动14050ms新增性能失败，13PID/3组清空。具体初始frame事件未被原记录捕获，不能断言根因已确定。真实准备函数[红例](READINESS-RED.txt)后，仅验证器对执行前明确过期观察记错并重新取两份连续稳定样本，8次/15秒不变，未知错误照常退出，不重试产品输入。[29项验证器](READINESS-GREEN.txt)通过后复用103。所有失败、假设及范围见[SOURCE-FAILURES](SOURCE-FAILURES.md)。

## 固定候选和实包证据

[最终候选103](BUILD-103.json) `inline-frame-origin-23`，0.2.2/格式32、54签名映像，来源cce402d加精确未提交输入，不能事后改成本阶段提交。[包预检](artifact-103/PREFLIGHT.json)artifactVerified=true；退出2仍仅4根许可证正文缺失（@ai-sdk/provider-utils、client-only、drizzle-orm、saxes），releaseAccepted=false。整包SHA-256：`d12f303054f0814e8ac829b932c16d8d8f61d31c40a09674c8d0f1cd1f3abcf3`。102及原始预检保留。

构建103后只改两份验证器文件，产品、测试应用代码及整包不变；[RETRY-INPUTS](RETRY-INPUTS.json)保存两份精确旧/新摘要，[VERIFY-BUNDLE](VERIFY-BUNDLE.mjs)逐文件核对这一限定差异与全包，明确inputsUnchangedAfterBuild=false，不改写构建来源。

| 模式 | 启动 | 结果 | 输入事件/成功规划 | 自有PID/组 |
| --- | --- | --- | --- | --- |
| [inline-success](success/INDEPENDENT.json) | 276/277 | E空blank DIV、C已有两段srcdoc BODY，精确写入2/3行，confirmed/complete | 8/4 | 26/6 |
| [inline-replace](replace/INDEPENDENT.json) | 278/279 | 首行后同URL替换srcdoc iframe，原生frame身份/AX根改变、generation 2→3，unknown/page-change暂停，无续写 | 1/1 | 24/6 |
| [inline-focus](focus/INDEPENDENT.json) | 280/281 | 首行后blank焦点移外层INPUT，外层仍空，unknown/paused，无续写 | 1/1 | 24/6 |

三轮分别12.674/12.992/13.873秒，都正常退出并冷开，没有新增规划或输入。正例保留中文、尖括号、&及精确单LF；C来源AX双LF原样保存。反例均无richTextResult。现有during-action导航审计只接收HTTP(S)，srcdoc替换不补造该事实；宿主撤权、代次变化及未知暂停仍生效。

[独立核验](VERIFY.py)直接读取SQLite格式32/quick_check、原始DOM/AX及宿主真实来源/父归属、每次网站收件、独立GET和最终AX全文，不调用产品判定函数。74PID/18组在最终三轮清空，连同两次失败合计100PID/24组；共享租约已释放，16份空stdout/stderr及空OS结果保留。原始运行run-1794037481247、run-1794037514409、run-1794037544609；资料`/private/tmp/helpr-workspace-validation-501/run-fT4UeA`、`run-Pi9zkb`、`run-7AlXav`。失败274为run-1794036575421/run-5mM26f，275为run-1794037356992/run-hc8vf4；所有资料和候选保留，没有本轮缓存清理。

## 用量、未验与接续

累计 **103构建/19测试安装/281启动/52故障/25清理**。本阶段2候选/8启动/4整体填写/7虚构请求（6成功规划、1失败）/10网站输入事件/0发布。真实模型费用、远程业务写入、正式安装和系统权限操作0；release-23-real-business-v1已有授权消费0，不重复询问。

后续六次启动3625/2568/4427/2661/4626/3384ms不能抵消274/275及所有旧性能失败；无06原生切换/RSS/完整5分钟，性能未通过。本轮未调用CUA，未取得窗口/真人证据；旧连接失败和21遗留IAB清理未知保持，没有新建浏览器标签。脚本焦点转移不是真人接管。

下一阶段继续实际通用前置，优先无AX角色/名称编辑器的可核对定位，随后补内联发布字段/流程学习复用；不能用假名称或伪造角色绕过观察。无只读身份的空白创建、一般管理页、跨页附件及explicit-current-url跨页复用仍缺。17仍7/9、21仍1/8、22仍7/9，09旧范围不替代最终候选全量升级。全部通用前置、本机组合、最终候选及本人登录齐备后才运行已授权真实批次。23仍0/15，不新增24、不推送；本地提交后同工作区串行新聊天交接。
