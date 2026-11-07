# 23：继承来源的内联子文档富文本

接续cce402d。本阶段扩展唯一about:blank / about:srcdoc子文档，仍要求精确命名AX textbox、显式普通contenteditable和完整全文。除了已有frame tree/DOMSnapshot/AX根与可见IFRAME父归属一致，还须所属宿主WebFrameMain.origin等于主网站HTTP(S)来源，原生父节点/URL/身份完整且前后不变；CDP的securityOrigin只允许该来源或实际观察到的`://`，后者不能单独证明来源；blank的owner只能无src、空src或about:blank，且无srcdoc；srcdoc必须有srcdoc属性。所有祖先同站、无sandbox/隐藏/受保护标记，重复URL/身份、opaque来源、快照缺失均拒绝。主网站URL策略不扩大，内联文档不补原生字段或结果链接，格式32不变。

使用实际frameUrl，不猜地址；每段继续固定节点、焦点、原backend/页面代次/会话与精确前缀核对，最终逐字比较。16秒动作截止、无重试、最多4000字符/32非空行及空行/CR限制保持。无AX角色/名称、复杂编辑器及保留格式仍待后续。

源码核对来源缺失/冲突、opaque、sandbox、同址歧义、归属缺失、嵌套归属和原协议/停止回归。冻结inline-frame-origin-23，构建10分钟、预检2分钟。三轮独立隔离资料：inline-success覆盖blank空DIV和srcdoc已有两段BODY；inline-replace首段后同址替换srcdoc；inline-focus首段后blank焦点移外层。每轮3分钟/2启动/单案40秒/准备8次，总6启动/4整体填写/6虚构规划/最多12输入事件/0发布。只在具体修正或新证据下有界复跑，失败累计不抵消。

通过同一受管入口取证，网站脚本只生成测试页面和独立收件，不替产品输入。正常退出冷开不重发；独立核SQLite/源DOM/AX/每段收件/最终全文、包输入及OS PID/组清空与租约释放。CUA窗口、脚本与真人证据分开；不并发启动第二轮。真实模型/远程写入/正式安装/系统权限0，已授权真实批次消费0。23仍0/15，本地提交后串行新聊天交接，不新增24、不推送。

102/274原始失败：空blank中已有完整编辑根，但Page.Frame.securityOrigin实际为`://`，错误将此字段等同真实来源使产品在输入前拒绝。0动作/0输入、1失败虚构请求，13PID/3组清空。保留原候选及资料，不把`://`直接放行。新增私有宿主frame-origins只读请求：核对task/target/generation后同步读取WebFrameMain的url/origin/frameTreeNodeId/frameToken/processId/parent/detached；控制侧同一资格下前后两份必须完全一致，逐层唯一URL、实际origin及父归属与CDP/DOM对应，真实opaque/null仍拒绝。无新CDP能力、网页脚本或外部入口。最终候选改为inline-frame-origin-23，重新完整检查和构建；原三轮最多6启动/4填写/6规划/12输入不变，含失败累计最多7启动与7虚构请求。原启动8714ms失败保留。

103/275第一次准备观察因OBSERVATION_NOT_AUTHORIZED退出，0模型/动作/输入，启动14050ms，13PID/3组清空。用真实准备函数红例后，仅验证器对执行前明确过期观察记录并重新取得连续稳定样本，8次/15秒不变，未知错误不吞掉；不修改产品或重发动作。同候选103重新执行原三轮，累计最多8启动，构建后两份验证器差异单列。
