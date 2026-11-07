# 23阶段：无角色或名称的普通富文本定位

2026-11-07，接续c6f6519。实现普通contenteditable的可核对结构定位和输入，**事项23仍0/15**，不是完整发布、WordPress/Drupal或整体交付通过。

## 实现与边界

只有完整所属DOM快照、非忽略/非保护AX编辑根、普通可见contenteditable结构及完整正文齐备，才提供一次性定位。沿DOM元素父链生成最多33层/2000字符的精确结构路径，按nodeType计数包含SVG在内的元素兄弟，绑定原backendNodeId和实际frameUrl；缺类型、shadow/document-fragment父链、隐藏/保护祖先、重复身份和复杂内容拒绝。保留网页实际AX角色与名称，不注入textbox、名称、站点选择器或网页脚本。已有可用命名textbox保留原角色定位。

新target仅fill允许，不能用于点击/选择或任意CSS。记录层和执行前核对源证据；工作者固定ElementHandle后，首输入前再等待控制拥有者核对原backend/页面代次/会话/完整源值，之后确认路径仍对应固定句柄才输入。首行fill、受控软换行及insertText、逐段精确前缀回执、最终逐字比较保持；替换、停止、焦点和接管不重填。16秒动作截止、4000字符/32非空行、CR和首尾/连续空行拒绝不变。没有新CDP能力。

非空值仍来自AX，DOM文字只交叉核对，不能用结构路径推算正文。主文档和此前已核对归属的HTTP(S)/blank/srcdoc子文档共用路径；宿主真实来源/父归属守卫不变。新定位不提供发布字段绑定或可重放流程规则，修复和reboundAction明确拒绝跨次重用节点身份；历史证据可以保存，不等于可复用。内联发布字段/学习复用的HTTP(S)约束仍须后续。

格式33接续32，先备份workspace-before-rich-text-locator-23-*；冷开和备份保存新定位及源/结果证明，导入仍restoreReview。结构目标缺源证明或locator内部身份不一致拒绝。没有迁移正式资料或替换正式安装。

## 源码证据

[初始123项定向](TARGETED.txt)通过；[第一次完整574项](SOURCE-BASELINE.txt)为573通过、1失败：第二处版本守卫遗漏格式32，迁移反例捕获后修正。类型/格式/lint开发失败与全部旧失败见[SOURCE-FAILURES](SOURCE-FAILURES.md)。

重新compile后[完整基线](SOURCE-FINAL.txt)通过 **577应用/30验证器/25旧回归及typecheck、lint、format**，应用265.88秒。之后只补命名textbox保留原路径和跨次rebound显式拒绝两个边界；[最终159项富文本/流程定向](TARGETED-FROZEN.txt)、[最终静态](STATIC-FROZEN.txt)通过。最终构建重新编译全部输入，不把后两项修改冒称已在此前577项全量运行。

定向覆盖节点/路径/frame/完整值/重复/截断/只读、祖先保护、SVG元素序号、shadow或缺类型、首输入前拒绝/替换/停止、逐段回执、保存/冷开/真实备份及32迁移。源码角色变化样本是明确派生契约夹具，真实无角色证据由下列新包独立取得。

## 固定包与实测

[候选104](BUILD-104.json) `rich-text-locator-23`，0.2.2/格式33、54签名映像，来源c6f6519加精确构建输入，不事后改为本阶段提交。[预检](artifact-104/PREFLIGHT.json)artifactVerified=true，退出2仍仅四根许可证正文缺失（@ai-sdk/provider-utils、client-only、drizzle-orm、saxes），releaseAccepted=false。全包SHA-256：`5b5bdcdfdbc651793fc05eae4bfa88dc0b8625570fd4eeab78d40accc4a4d8c1`。

| 独立资料轮 | 启动 | 结果 | 输入/规划 | PID/组 |
| --- | --- | --- | --- | --- |
| [node-success](success/INDEPENDENT.json) | 282/283 | 主文档空DIV、原P/BR、已有两段，精确2/2/3行，confirmed/complete | 11/6 | 28/6 |
| [node-inline-success](inline/INDEPENDENT.json) | 284/285 | blank空DIV、srcdoc已有两段BODY，精确2/3行，confirmed/complete | 8/4 | 26/6 |
| [node-replace](replace/INDEPENDENT.json) | 286/287 | 首段后同位置替换编辑根，backend改变，只1输入，unknown/paused | 1/1 | 24/6 |
| [node-focus](focus/INDEPENDENT.json) | 288/289 | 首段后焦点移外层INPUT，外层为空，只1输入，unknown/paused | 1/1 | 24/6 |

四轮分别13.882/9.556/7.678/7.855秒；全部正常退出冷开无新增规划或输入。所有实际编辑根AX角色都是generic、名称为空，DOM没有role或aria-label属性；正文中文、尖括号、&及单LF保留，原P/BR的LF和非空段落源双LF原样核对。两反例无richTextResult，无伪造导航许可。网站脚本仅生成网页/收件/反例，不替产品输入；焦点脚本不算真人接管。

[独立VERIFY.py](VERIFY.py)直接读取SQLite格式33/quick_check、DOM元素父链与属性、真实AX源/结果、原backend、内联宿主来源/父归属、每次网站收件和独立GET，不调用产品判定函数。[包复核](BUNDLE-VERIFIED.json)及[脚本](VERIFY-BUNDLE.mjs)确认所有构建输入和整个包在四轮后均未变。102自有PID/24组逐轮OS清空，跨聊天租约释放；16份空stdout/stderr及8份空OS结果保留。

原始运行run-1794039133026、run-1794039159853、run-1794039175899、run-1794039191012；隔离资料分别`/private/tmp/helpr-workspace-validation-501/run-TpWZsl`、`run-d1w6dS`、`run-yaEuRF`、`run-55pEot`，全部保留，无本轮缓存清理。

## 用量、待验与接续

累计 **104构建/19测试安装/289启动/52故障/25清理**。本阶段1候选/8启动/7整体填写/12虚构规划/21输入事件/0发布。真实模型费用、远程业务、正式安装、系统权限均0，已授权release-23-real-business-v1消费0，不重复申请。

282启动5347ms超过5000ms，新增性能失败；其它2036/1914/2555/1441/1685/1739/1823ms不能抵消，旧全部启动失败保留。无06原生切换/RSS/完整5分钟，性能未通过。CUA getState本轮30秒超时并已收束，无窗口/真人证据；未新增标签，21旧IAB清理未知保持。

下一阶段继续实际通用前置：普通富文本的发布字段绑定（包括实际about frame），以及跨次流程如何重新取得当前节点，不能保存backend身份直接复用或用假名字绕过。无完整AX全文、复杂编辑器、无只读身份空白创建、一般管理页、跨页附件和explicit-current-url跨页复用仍缺。17仍7/9、21仍1/8、22仍7/9，09旧范围不替代最终候选全量升级。全部通用前置、本机组合、最终候选冻结及本人登录齐备后才运行既有真实批次；23仍0/15，不新增24、不推送。本地提交后同工作区串行新聊天交接。
