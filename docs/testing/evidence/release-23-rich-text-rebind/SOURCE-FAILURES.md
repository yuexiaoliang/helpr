# 失败与验证边界

TYPECHECK-FIRST拒绝reboundAction的新输入/已确认字段联合类型推断，把richText缩窄成unknown；显式给fields标注Publication字段类型，原语义与守卫不变。TYPECHECK/TYPECHECK-SECOND通过，后续完整检查另记。

TARGETED-FIRST为55通过/5失败。新规则首次学习成功，但复用上传/草稿后，ask以WORKFLOW_SCOPE_CHANGE拒绝，未到预览；没有任何复用正文或提交。按diagnosing-bugs技能缩小到单主文档复用，DIAGNOSTIC捕获同一错误及两个confirmed准备动作，2.22秒复现。原因是重新定位返回fields的属性插入顺序与schema解析后的publication.fields不同，JSON比较误报变化。修为通过publicationFieldsSchema规范化之后再比较，没有放宽字段值/语义/定位；REBIND-GREEN原5项13.42秒全过。临时DEBUG-rebind探针已移除，不保留在产品或测试路径。

不把源码的观察/perform契约夹具写成实际浏览器输入；实际DOM/AX、原生内联来源、网站收件和冷开由固定候选另验。旧unusable候选不补规则；同一路径仅能在当前完整证明和本次确认下取得新节点。确认后仍固定原backend/target/generation，不在节点失效时重新定位。现阶段explicit-current-url仍只限同站同入口路径的线性流程，不声称已实现跨页复用或任意编辑器。

旧性能失败、4根许可证正文缺失、原生输入/休眠/中文输入法/本人操作、21旧IAB清理未知及其他通用前置保持。真实release-23-real-business-v1授权消费0，23仍0/15。

106/301–302首次main实包：A首次和D换素材均完整通过；中途冷开后G以MODEL_CREDENTIAL_UNAVAILABLE暂停，SQLite中1次未发送错误模型记录、0 G动作，网站无G规划。隔离虚构凭据按设计不跨进程持久化，验证器只在初开配置，漏掉冷开后的新委托配置。保留failed-main所有原始数据、资料run-xaPYry及独立OS清理；5136ms和5679ms均新增启动性能失败。产品/候选不改，只在中途冷开且所有旧动作/收件计数一致核对后，按公开model-save重新配置相同固定虚构凭据。最多追加一个main完整组3启动/3上传/3草稿/3发布/12虚构规划；旧2上传/2草稿/2发布和11次模型尝试（10发送）累计保留，不复用失败资料。

CUA getState单次10秒超时并kernel reset，已completion_summary收束。未取得本轮窗口、真人、输入法或休眠证据；未打开新浏览器标签，21旧IAB清理未知保持。

106/309–311首次srcdoc：C/F/I三份实际发布、复用、冷开记录及无新增动作计数均已核对，但最终quit返回UNSAVED_CHANGES；该轮完整结果仍失败，不以部分成功改写。原始process记录及controller日志表明最终311随后由统一finally再次正常quit、exit code 0，无强制清理，49PID/9组清空。ready到最终exit仅约570ms。此证据支持“冷开manual投影不等于异步页面保存/恢复均已稳定”的新假设，无法仅凭现有日志确定是哪一个pending集合；不声明已定位产品底层缺陷。

验证器在中途及最终冷开后为每个恢复页执行已有richTextReadiness（最多8次/15秒、两次完整DOM字符串摘要相同），再比对持久记录和副作用计数后请求退出。保留原退出守卫，不吞UNSAVED_CHANGES、不重发网页动作。复用不变106，另追加一次独立srcdoc完整组最多3启动/3上传/3草稿/3发布/12虚构规划；原失败11规划/3发布及资料run-VuPWon全部保留。构建后仍只一份验证器变化，其历次运行输出和最终摘要单列。

最终git diff --check仅报告原始构建/编译日志的`gyp info ok `尾空白，以及诊断/测试输出原有末尾空行；源码、脚本和测试无空白错误。保留原始日志，不为通过格式检查重写执行证据。
