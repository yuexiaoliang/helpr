# 23：受管同站子 frame 的富文本输入

接续7a1cfe2。只扩展完整、唯一同站HTTP(S)子frame：当前受管frame tree、同一DOMSnapshot的frameId/URL、AX RootWebArea.frameId及父文档可见IFRAME的contentDocumentIndex逐层对应。重复URL、重复身份、sandbox、隐藏、跨站/跨进程快照缺失拒绝。显式contenteditable的BODY可作为编辑根；仍须精确命名AX textbox、完整普通结构、AX全文与DOM文字交叉核对。未命名/无角色、srcdoc/about:blank及复杂编辑器留待后续。

控制拥有者观察前后frame tree必须不变；每段仍核对原backend节点/页面/会话/精确前缀，工作者固定节点并检查子文档实际焦点，防止外层焦点转移后续写。使用既有frameUrl和richText事实，格式32不变，无新CDP能力。最终全文逐字比较，空行/CR及32非空行/4000字符边界不变。

源码核对归属缺失、同址歧义、隐藏、跨站、节点替换、焦点转移与停止回归；然后冻结rich-text-frame-23。构建10分钟、预检2分钟。最多三轮独立隔离资料，每轮3分钟、2启动、单案40秒、准备8次：frame-success覆盖空DIV和非空BODY；frame-replace在首段后替换同URL iframe；frame-focus在首段后把焦点转到外层字段。合计最多6启动、4整体填写、6虚构规划、12输入事件、0发布。每轮正常退出冷开不重发，独立读取SQLite/DOM/AX/网站收件与GET，OS确认PID/组清空、租约释放。具体新依据才有界复跑，所有失败累计。

不启动真实模型/远程业务/正式安装/系统权限，不消耗release-23-real-business-v1。真实窗口使用CUA；脚本、桌面与真人证据分别记录。23仍0/15，不新增24，不推送；完成后本地提交及同工作区串行交接。

101首次267在15秒就绪截止失败，0任务/输入/规划，11PID/3组清空。日志显示ready刚超截止，按新映像首次初始化/持续启动阻塞/并发观察干扰三个可检验假设，仅一次同候选新资料复跑，不并发CUA且不延长门槛。若复跑就绪，则继续原三轮；累计最多7启动，业务输入预算不变。旧失败不抵消，根因与性能仍未通过。
