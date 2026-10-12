# helpr 首版技术决策地图

Label: wayfinder:map
Status: open

## Destination

明确足以编写首版实现规格的技术方案：让已确认的真实网页工作区、最多两项任务并行、运行时流程学习与复用、用户参与和恢复要求，都有可实施的机制与必要的运行证据。地图完成后进入 `/to-spec`，再拆分实现事项；完成本地图不等于产品已实现或通过首版验收。

## Notes

- 产品范围已确认，以 [产品共识](../../docs/product/product-agreement.md)、[访谈记录](../../docs/product/discovery.md)和 [验收范围](../../docs/product/acceptance-outline.md)为依据。沿用已有决定；新事实影响范围时明确指出影响并与用户确定。
- 始终使用中文。每次工作先读仓库 [协作约定](../../AGENTS.md)、[术语表](../../GLOSSARY.md)及相关 ADR；首版 [本机执行](../../docs/adr/0001-local-execution.md)，[具体任务逻辑来自运行时流程](../../docs/adr/0002-runtime-workflows.md)。
- 每次调用遵循 [wayfinder](../../.agents/skills/wayfinder/SKILL.md)。对话决策使用 [grilling](../../.agents/skills/grilling/SKILL.md)和 [domain-modeling](../../.agents/skills/domain-modeling/SKILL.md)；资料调查使用 [research](../../.agents/skills/research/SKILL.md)；状态或界面讨论使用 [prototype](../../.agents/skills/prototype/SKILL.md)；设计 Module 与 Interface 时使用 [codebase-design](../../.agents/skills/codebase-design/SKILL.md)。按事项需要读取对应技能，不把阅读材料当作完成实验。
- 本地图使用 [本地事项管理约定](../../docs/agents/issue-tracker.md)。子事项位于 `issues/`，先创建事项再设置依赖；从 `Status: open`、全部依赖已解决的事项中按编号选取，先改为 `claimed` 再工作。事项按名称引用，答案只记录在对应事项的 `Answer` 中，地图仅索引结论。
- 2026-10-10，用户强调探路与复用是核心，要求更严谨可靠的设计。[验证上传授权与完整流程的分阶段检查](issues/17-upload-authorization-and-workflow-checks.md) 已补全当前后台的真实路径、模型校准与冻结后保留集，结束该前置验证的优先处理，恢复按编号选取。完整复用证据与所有副作用均在授权范围内的保证仍须区分，已暴露的请求关联未知由独立事项进入最终组合选择。
- `Mode: HITL` 需要真人参与相关核对或决策；`Mode: AFK` 可由 agent 独立工作。真实鼠标、中文输入与粘贴的对照，不能用自动化事件冒充真人证据。用户无需为此学习调度或锁等内部机制。
- 技术实验归为 `task`：它们取得下一项决定必需的运行事实。`prototype` 用于让用户核对状态或界面行为，其模拟结果不能替代真实浏览器证据。实验只做到足以回答问题，产物标明实验用途，不发展成预设架构的产品实现。
- 已有 [WordPress 网页验证证据](../../docs/testing/validation-backend.md)只证明独立后台的附件发布路径可用。已有 [浏览器原语调查](../../docs/research/browser-execution-primitives.md)、[可见工作区调查](../../docs/research/visible-browser-workspace.md)和 [并行调查](../../docs/research/parallel-execution-feasibility.md)可复用，所列未执行实验仍需取得证据。
- 旧版 flowpolit 仅作只读参考，遵循 [已核实的参考边界](../../docs/research/previous-product-reference.md)。早期候选工具调研与调度建议不单独构成技术选型结论，以对应的已解决决策为准。
- 模型凭据与测试账号口令不写入地图、报告或 Git。接入事项记录配置位置和验证结果。需要管理 `home` 时使用 `essh`；它只承载验证网站，已有服务保持独立。
- 研究报告保存在独立 `research/*` 分支并推送，主工作目录的未提交资料不随之提交。事项记录报告、提交和分支位置；这些研究分支不合并到产品分支。
- 日常可逆实现细节由工程工作处理。本地图收敛影响架构、正确性与交付范围的决定，不要求在编写规格前确定每个字段、文件或依赖版本。

## Decisions so far

- [筛选第二套开源验证后台](issues/04-second-backend-research.md)：Drupal 为首选，Ghost 为备选；资料支持测试候选，真实网页与跨后台流程仍待验证。
- [验证真实网页的页面归属、并行与输入来源](issues/01-visible-page-control.md)：两种候选均取得页面绑定与双页重叠证据，Electron 真人输入核对通过；单一事件标记不足以判断人工来源。
- [验证独立停止与迟到结果的处理](issues/02-independent-stop.md)：两种候选取得执行身份校验与原语取消的运行证据；已接收提交和无法取消的浏览器内部工作仍可能完成。
- [确认现有模型 API 的接入条件](issues/03-model-api-access.md)：测试模型 `deepseek-flash` 的 8 项真实接口检查通过；用户可自行配置服务，实际网页执行器组合继续验证。
- [验证参数化流程的冷启动重放与修复更新](issues/05-runtime-flow-replay.md)：在预定义参数和独立测试断言下，AI 学得的动作序列可换素材跨进程重放，受控控件变化经修复后保存新版；两次稳定重放均无模型调用，尚未证明完整流程的适用性与学习机制。
- [验证流程适用性、步骤条件与修复边界](issues/14-workflow-reliability-contract.md)：候选执行约定取得 15 类场景的符合预期证据，旧可见性等待的误判与受限修复均得到验证；最终候选仍有实验程序辅助组装，自动归纳缺口转为独立前置验证。
- [验证无需人工修订的流程归纳与条件校准](issues/15-autonomous-workflow-induction.md)：完整自动归纳未通过；受限字段观察提议取得真实正反状态、换文字局部复用及控件变更时停止的证据，完整闭环转为后续前置验证。
- [验证受限提议下的完整流程归纳](issues/16-constrained-workflow-induction.md)：十步局部复用及错误效果提议拦截得到验证；上传字节观测假设被反例否定，完整路径与保留集仍未成立。
- [验证上传授权与完整流程的分阶段检查](issues/17-upload-authorization-and-workflow-checks.md)：十四步完整路径、模型校准与冻结后保留集通过；分阶段证据可用，请求与副作用的关联保证仍需独立验证。
- [验证可见工作区中的 AI 双页操作归属](issues/06-ai-parallel-binding.md)：两种宿主各取得九项真实模型与逐原语控制证据，页面、弹窗、停止及错误保持归属；完整业务并行与真人接管仍不能由此推定。
- [验证提交中断后的实际结果判定](issues/08-result-recovery-evidence.md)：四种中断位置取得重新判定与有限续跑证据，同名任务及用户意图保持归属；可能已派发且结果不明时不自动重试。
- [核对并行执行与用户参与的状态模型](issues/09-participation-state-model.md)：原型明确各任务的参与与控制归属；用户确认停止后明确继续时先核对再续做，已完成不重发。
- [取得第二后台的流程对照证据](issues/11-second-backend-comparison.md)：Drupal 七步流程、模型位置校准及冻结后保留集通过；两次通用程序修订与全部失败保留，跨站通用性的保证仍有明确范围。
- [验证人工接管的输入识别与让出操作](issues/12-human-input-takeover.md#answer)：macOS / Electron 已登记视图中的真人点击、中文、粘贴及核对后继续通过；页面变化后的归属缺口保留为选型前置验证。
- [验证素材、内容预览与发布版本的关联](issues/13-material-preview-binding.md#answer)：两版 Excel、真实模型建议与三次网页发布保持来源和确认归属，旧确认及参数替换被拒绝；取得持久化所需的最小版本关系。
- [验证网页动作、上传数据与写请求的关联边界](issues/18-action-request-association.md#answer)：完整 HTTP 实体检查能约束受控请求和文件，时间窗口、文件名及同内容一次性许可仍有误关联反例；通用授权保证未成立，范围取舍进入组合选择。
- [验证页面变化后的输入归属与继续](issues/19-page-lifecycle-input-ownership.md#answer)：刷新失配已复现定位，受控生命周期中的重新绑定与核对后继续通过；未知归属仍暂停两项，升级兼容及真实休眠恢复未获保证。
- [确定浏览器承载与流程执行组合](issues/07-browser-runtime-decision.md#answer)：首版采用 macOS / Electron、Playwright 与统一受控的结构化流程执行；用户接受未知输入时暂停两项及网站隐含写入的明确保证范围。
- [确定执行记录、流程更新与定时恢复的约定](issues/10-durable-execution-contract.md#answer)：统一保存本机关联记录，按约定、目标和素材版本记处理事实；恢复先核对、旧工作不重复领取，并发流程候选不互相覆盖，持久一致性与自动恢复依据另行验证。
- [确定本机交付、权限与更新约定](issues/20-local-delivery-and-updates.md#answer)：当前 Mac 自用、关窗口继续、遵循休眠、本机保留与备份；自动检测、默认手动安装及可选空闲自动更新，控制隔离和打包更新另行验证。
- [验证持久记录与执行资格的中断一致性](issues/22-durable-record-consistency.md#answer)：本机中断与并发记录取得受控证据，容量遗漏和启动锁争用经反例修订；已派发效果与未落盘意图仍保留明确限制，真实网页和交付验证继续。
- [验证浏览器控制连接与宿主隔离](issues/24-private-browser-control.md#answer)：私有 pipe 与受管进程转接取得 43 项限定证据，补齐消息顺序及自有视图退出；无裸调试端口，未覆盖协议和真实网站仍须继续核对。
- [验证恢复核对依据的自动形成](issues/23-autonomous-recovery-evidence.md#answer)：真实模型与执行形成恢复依据，冻结后新进程可核对草稿及丢失回执的结果；无稳定关联或提交不确定时仍不重发，完整组合与打包继续验证。

## Not yet specified

暂无未归入事项的已知问题。后续决定暴露的新问题仍按是否可具体表述形成事项。

## Out of scope

- 实现并交付完整 helpr、编写最终规格和实现工单：本地图完成后分别交给 `/to-spec`、`/to-tickets` 及实现流程；本阶段的代码仅用于取得决策所需证据。
- 扩展已确认的首版范围，例如超过两项自动并行、多机器执行，或批量新增和更新后台记录。
- 承诺微信公众号、小红书等具体平台已受支持；支持范围以相应真实网页验证为准。
- 为选定后台或 Excel 任务编写产品专用业务实现，或默认沿用 flowpolit 的技术架构。
- 在本轮首版交付 Windows、Linux 等其它平台；用户已选择先支持 macOS，其它平台取得同等证据后另行支持。
- 首版同时覆盖其它 Mac 环境或正式向他人分发：当前先交付本人这台 Apple Silicon / macOS 14.8.3 的 Mac，扩大范围另行取得条件与证据；自用应用的自动检测及可选空闲更新仍在首版范围，见[本机交付约定](issues/20-local-delivery-and-updates.md#answer)。
- 默认自动到期删除历史或自动将备份上传云端：首版采用本机保留、用户主动清理与本机备份，见[本机交付约定](issues/20-local-delivery-and-updates.md#answer)。
- 构建能在发送前证明并隔离任意网站全部隐含写入的通用系统；已确认首版按委托约束 helpr 自身操作并核对结果，发现异常仍须停止后续自动动作和核对，详见[确定浏览器承载与流程执行组合](issues/07-browser-runtime-decision.md#answer)。
