# 失败与证据边界

上一阶段与更早的所有失败保留，包括新映像首次就绪延迟、启动超5000ms、4根许可证正文缺失、真人/输入法/休眠及21遗留IAB清理未知。本阶段未取得CUA窗口或真人输入证据，脚本反例不充抵真人接管，也不据源码测试宣称完整性能通过。

70项初版定向通过；新增内联持久化和逐段回执后95项定向及3项夹具通过。随后增加嵌套blank→srcdoc归属反例，最终完整检查另记。

打包前复查夹具：初版blank用父文档调用child.open/write。按[HTML标准document open步骤](https://html.spec.whatwg.org/multipage/dynamic-markup-insertion.html#document-open-steps)，完整活动文档会更新为调用入口文档URL，不能假定保留about:blank。此时尚未构建或启动候选，不能把该推断写成实包失败。完整检查运行中不修改输入，检查结束后仅修正夹具的初始生成方式，再单列验证器结果；产品仍要求frame tree与DOM实际URL严格一致，不放宽为同URL歧义。产品输入始终由受管Playwright执行，夹具脚本只初始化本机网页和独立收件。

无AX角色/名称、重复frame URL、复杂编辑器、CR/空行及32非空行限制仍缺或拒绝。已有publication.fields的frameUrl和流程学习/修复仍要求HTTP(S)/同站URL，内联富文本的完整发布与复用组合未由本阶段输入能力打通，须后续推进。未知创建/上传/发布的边界不变，真实授权消费0。

102/274：实包10.575秒后RICH_LINES_INTERRUPTED，源DOM/AX已有普通空DIV，但Page.Frame.securityOrigin=`://`，richText缺失，虚构服务1失败请求/0成功规划，0预留/0输入。启动8714ms新增性能失败；13PID/3组OS清空，资料run-5mM26f及原运行run-1794036575421保留。ORIGIN-RED用实际原始快照稳定复现拒绝，未重新启动应用。

三个假设为CDP字段不能表达实际继承来源、宿主阻断导航导致空文档、真实opaque来源。原DOM/AX完整编辑根否定“没有编辑文档”；[Electron WebFrameMain.origin](https://www.electronjs.org/docs/latest/api/web-frame-main#frameorigin-readonly)与本机44.7.2类型定义明确区分URL和真实来源，opaque为null。新增宿主只读来源与父归属，绑定原task/target/generation并前后核对完整原生身份；不使用网页脚本或放宽://为默认同站。ORIGIN-GREEN的真实274快照仍在缺宿主事实时拒绝，补充契约夹具才可证明路径；该夹具不是274实际原生读数。42项涵盖错误来源/父节点/重复URL/身份/token/detached/根来源及嵌套，实际来源须由新候选独立取证。

103/275：15.582秒在第一次准备DOM观察返回OBSERVATION_NOT_AUTHORIZED；尚无domBefore、模型请求、动作或输入。启动14050ms新增性能失败，13PID/3组清空；run-1794037356992 / run-hc8vf4保留。该错误来自当前资格/代次/令牌不再匹配；原始样本不足以确定是哪次初始frame事件。假设依次为初始导航代次变化、旧资格残留、令牌错误；验证器每次创建并关闭独立资格且未自定义令牌，优先修准备阶段对明确过期观察的处理，不把归因写成已证明。

READINESS-RED在真实验证器准备函数用一次OBSERVATION_NOT_AUTHORIZED复现直接退出；修后只对PAGE_NOT_AVAILABLE/OBSERVATION_NOT_AUTHORIZED/STALE_OBSERVATION记原错误、清除稳定指纹再读取，仍最多8次/15秒，两份连续稳定样本才进入动作。其它错误照常退出；只发生在执行前，只读，不重发输入。READINESS-GREEN为29项验证器通过。产品与候选103不变，复用同包；构建后精确两份验证器差异列于RETRY-INPUTS.json，VERIFY-BUNDLE按此核对全部输入和整包，不能冒称所有输入未变。后续原三轮成功/替换/焦点仍须重验，包含275累计最多8启动/7虚构请求，旧失败不抵消。

最终103的276–281三轮通过，实际WebFrameMain.origin均为父网站来源，blank的CDP securityOrigin仍为://，支持首项来源字段判断缺口。srcdoc替换的旧HTTP(S)动作导航审计保持缺省；真实原生/AX身份变化及generation 2→3和page-change暂停独立核对，不补造导航事实。后三轮低于5000ms不抵消274/275和全部旧性能失败，也不证明275的具体事件来源或首次新映像延迟已解决。本轮未调用CUA，没有窗口/真人证据。
