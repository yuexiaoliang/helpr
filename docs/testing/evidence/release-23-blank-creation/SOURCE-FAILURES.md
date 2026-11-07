# 失败与边界

首次定向72项，71通过，新增格式30冷开用例失败DATA_VERSION_UNSUPPORTED；原始输出见TARGETED-INITIAL.txt。调用栈直接指向workspace.ts构造中的第二道版本条件：首道允许30并创建迁移前备份，但后续显式version !== 1…29及CURRENT_DATA_FORMAT拒绝30。修正第二道条件接纳30。该字面量遗漏已有实际持久化红例，无须增加猜测、调试日志或做二分；保留原始场景复验和完整检查。

旧原生新映像首次运行延迟、候选93首轮takeover来源未知、性能超标、4根许可证正文缺失、CUA失败与21遗留IAB清理未知均保留。此阶段仅支持具有可核对只读身份的空白表单，不推定WordPress/Drupal必然提供此契约。

CUA本轮仅一次await cua.getState()，10秒超时、kernel reset，已提交completion_summary并停止尝试。没有取得窗口或真人新证据，不推断21旧IAB标签已清理。

候选94首次启动243在15秒就绪截止时APPLICATION_NOT_READY，总19.427秒收束，无网页/模型/创建。failed-243保留原result、两份空stdout/stderr、controller/records/host原日志及SQLite只读核对：格式31/quick_check=ok、0任务/0执行。records ready在05:30:33.252，比轮开始05:30:17.030晚16.222秒，已超过就绪截止；随后数条记录命令，host无ready，正常退出。11PID/3组OS清空、租约释放。不是身份功能失败，也没有证据断言原生误判。

排序假设：启动整体延迟（预测同映像再次启动在相同15秒截止前就绪）、记录进程失败（应有记录错误或损坏）、回执丢失（应有host/controller ready日志）。当前日志支持迟到初始化，暂不支持后两项，但不足以定位OS/签名/调度底层原因。保留失败，复用94且不改任何产品、超时或验证器；新隔离资料仅一次有界复跑，最多2启动/2创建/1正文/4规划/3分钟。若通过只说明第二轮通过，不宣称首次启动问题已修复。

244启动8226ms超过5000ms；产品就绪后第一次虚构规划返回IDENTITY_MISSING，0动作/0创建，总62.200秒超时，13PID/3组清空。245仅验证器增加本机控件失败快照、启动前AX证据和无pauseReason的paused立即停止；同94包，14.430秒收束，启动9279ms，0动作/创建、13PID/3组清空。实际身份readOnly=true且值完整，但正文textbox没有textValue。246再保存原已有DOMSnapshot只读采样以核对空值来源，同包11.955秒、启动7203ms，0动作/创建、13PID/3组清空。三轮各1次虚构模型请求失败，不计成功规划；原result/OS日志分别保留failed-244/245/246。94构建后仅scripts/blank-creation-fixture.mjs与scripts/form-navigation-validation.mjs增加诊断，产品未改；最终新产品须重新构建95，不把后改脚本写成94输入。

246的真实AX节点17没有value；对应主文档DOMSnapshot的backendNodeId=17、nodeName=TEXTAREA、textValue.index包含16且value为-1，明确存在空字符串条目。锁定Playwright协议声明对应textarea textValue；[Chromium实现](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/inspector/inspector_dom_snapshot_agent.cc)的AddString将空字符串编码为-1，SetRare仍保存该条目。此源码解释与实包观察一致；不把缺失的rare条目解释为空。

EMPTY-RED.txt保留真实捕获样本驱动的确定失败（1/1）；修正仅在观察层将同一主文档、AX可见非受保护、唯一backendNodeId的原生textarea/文本input的显式空值补成textValue=''，附emptyValue来源标记并计入指纹。其它节点、密码/隐藏类型、缺值、歧义或已有AX值不补。空白身份/原生/会话/网络链守卫不改。新候选blank-creation-empty-23（95），沿用10分钟构建/2分钟预检及最多2启动/2创建/1正文/4规划/3分钟新隔离轮，旧失败与计数全部保留。
