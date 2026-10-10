# 流程适用性、步骤条件与修复边界：运行报告

日期：2026-10-10。对应事项：[验证流程适用性、步骤条件与修复边界](../../issues/14-workflow-reliability-contract.md)。

本次实验支持继续采用“显式参数引用、实际状态检查、受限修复、结果核对后保存版本”的方向。最终候选覆盖的 15 类场景均取得符合预期的运行证据：6 类正确完成，8 类在提交前拒绝，1 类按停止信号终止。它们来自 19 次记录完整的执行，包含 4 次失败，不能表述为首次运行 15/15 通过，更不能据此估计生产可靠性。

**尚未证明自动学习可靠。** 最终候选来自实际模型提议和实验程序辅助组装；类型、输入槽位及部分规则绑定仍由测试驱动提供。整份流程生成与修订多次产生错误，已另建 [验证无需人工修订的流程归纳与条件校准](../../issues/15-autonomous-workflow-induction.md)，作为最终执行组合选型与第二后台对照的前置证据。

## 实验范围与来源

使用已有独立 WordPress 验证后台，通过真实浏览器创建虚构文章、上传 Excel 附件、发布并下载核对。没有通过服务端 API 或数据库写入来代替网页操作。模型使用已配置的 `deepseek-flash`。每个场景重新启动浏览器与上下文，复用测试作者登录态。

起点是先前 AI 探路所得的 17 步记录，最终形成 15 步候选。任务授权明确标记为测试夹具，不代表已经完成产品的内容预览、用户确认或自然语言解析。最终候选与结果证据分开保存，执行固定本次版本，失败候选不覆盖原流程。

- [候选约定](DESIGN.md)、[执行程序](executor.mjs)、[约束与绑定程序](contract.mjs)、[测试驱动](run.mjs)。
- [最终候选](artifacts/focused-bound-candidate/candidate.json)及[组合说明](artifacts/focused-bound-candidate/assembly.json)。候选按 `hash(JSON 对象)` 计算的摘要为 `396fd4b9d98e312053a63afcadef7cbad2a1e62c64e645dd5060c6ebb7b88199`，不是文件原始字节摘要。
- [证据索引](artifacts/evidence-index.json)记录全部 19 次执行、各场景最终证据、模型用量和当前复现源码摘要。较晚批次的 `results.json` 另记录当次执行源码摘要；不能声称所有批次使用完全相同的代码。

## 关键发现

### “控件可见”会误判上传已经完成

测试截住真实附件上传请求，在同一个页面观察上传前后状态，期间没有点击发布。上传尚未完成时，旧流程三个等待条件全部通过：文件名输入框和下载文字控件已存在。此时文件名实际值仍为空标记，下载地址不存在。

最终候选检查本次素材对应的文件名及同站点附件地址，上传进行中不通过，上传完成后通过。期望值来自当前任务素材引用。对照见 [真实页面条件验证](artifacts/final-condition-qualification/evidence.json)。这些是当前后台上有区分能力的条件，并非所有上传组件的通用完成定义。

另外一次完整执行把真实上传请求延迟 5 秒，提交发生在收到上传响应之后 194 毫秒；最终公开页面中的附件下载字节与原素材一致。见 [延迟上传完整执行](artifacts/final-path/delayed-upload/results.json)。上传前置检查与最终下载哈希各回答不同问题，不能互相替代。

### 参数引用、授权与实际页面状态须分别检查

只有结构化引用才绑定当前任务输入，普通字符串保留为常量。标题恰好为 `File` 的场景成功发布，同时编辑器用于查找文件区块的固定搜索词保持 `File`；后续不同标题仍使用同一搜索词。这消除了本实验中按样本文字全局替换造成的歧义。

错误任务类型、与授权摘要不符的栏目以及已被修改的素材均在开始流程写入前被拒绝。进入编辑阶段后，正文被替换、栏目被取消或标题控件出现两个匹配时，也没有继续发布。这里验证了显式条件的执行机制；任务类型如何从相似的自然语言委托中正确判定，尚未由本实验解决。

### 修复仅能修改失败步骤的定位，且必须重新核对结果

受控地改变标题控件名称后，模型提出改用实际页面中的稳定 CSS 定位。程序只接受当前失败步骤的定位替换，原任务输入、步骤条件、提交检查和结果规则保持不变。运行时核对公开标题、正文、栏目及附件哈希通过后，返回带父版本摘要和结果证据的候选；测试驱动再独立核对，才写入本实验的可复用版本。

新版在同样的控件改名下换输入完成，未再调用模型。试图删除结果检查的真实模型提议被拒绝；把已有合法提议的步骤标识改成另一条步骤，也被拒绝。后一个反例是故障注入，未再次调用模型。修复提交动作、改业务目标、改已确认内容、放宽条件均不在本次允许范围内。

## 最终场景证据

完成场景同时通过运行时结果规则与独立测试断言；后者以新上下文查看公开文章，核对标题、正文、栏目和实际下载字节。稳定执行中的 `baseline`、`repeat`、`literal-collision`、`delayed-upload`、`updated` 均无模型调用；成功的 `repair-safe` 调用模型 1 次。

| 场景 | 实际结果 | 运行记录 |
| --- | --- | --- |
| 基准发布 | 正确完成，[公开文章](http://home.ts-ali.internal:38080/?p=42) | [baseline](artifacts/final-path/baseline/results.json) |
| 换文字与素材复用 | 正确完成，[公开文章](http://home.ts-ali.internal:38080/?p=47) | [repeat](artifacts/final-path/repeat/results.json) |
| 标题与固定搜索词同为 `File` | 正确完成，[公开文章](http://home.ts-ali.internal:38080/?p=50) | [literal-collision](artifacts/final-path/literal-collision/results.json) |
| 上传请求延迟 5 秒 | 等待条件满足后完成，[公开文章](http://home.ts-ali.internal:38080/?p=53) | [delayed-upload](artifacts/final-path/delayed-upload/results.json) |
| 改名后限定定位修复 | 核对成功并保存版本 2，[公开文章](http://home.ts-ali.internal:38080/?p=64) | [repair-safe](artifacts/repair-retry/repair-safe/results.json) |
| 修复版本换输入复用 | 无模型调用完成，[公开文章](http://home.ts-ali.internal:38080/?p=67) | [updated](artifacts/repair-retry/updated/results.json) |

以下场景均核对了预期拒绝原因，没有发出本实验监测的发布请求；页面故障类还要求实际故障已注入，不能将任意加载失败计作成功拦截。部分场景此前已创建草稿或上传附件，“未发布”不等于“未产生任何网站变更”。

| 场景 | 程序结果 | 运行记录 |
| --- | --- | --- |
| 候选任务类型不适用 | `not-applicable` | [wrong-flow](artifacts/repair-retry/wrong-flow/results.json) |
| 更改授权所覆盖的栏目输入 | `authorization-mismatch` | [unauthorized-target](artifacts/final-negatives/unauthorized-target/results.json) |
| 确认摘要后修改素材字节 | `material-changed` | [material-changed](artifacts/final-negatives/material-changed/results.json) |
| 两个同名标题控件 | 严格定位失败，`target-unavailable` | [duplicate-control](artifacts/final-negatives/duplicate-control/results.json) |
| 提交前正文被外部修改 | `condition-unsatisfied` | [changed-content](artifacts/final-negatives/changed-content/results.json) |
| 发布按钮仍可用，但栏目已取消 | `condition-unsatisfied` | [changed-target-state](artifacts/final-negatives/changed-target-state/results.json) |
| 修复提议试图删除结果规则 | `repair-outside-allowed-fields` | [repair-unsafe](artifacts/final-negatives/repair-unsafe/results.json) |
| 修复指向另一条步骤 | `repair-step-mismatch` | [repair-wrong-step](artifacts/step-scope-check/repair-wrong-step/results.json) |
| 上传步骤开始时收到停止信号 | `execution-stopped`，未派发该上传动作 | [stopped](artifacts/stop-retry/stopped/results.json) |

## 失败、修订与模型开销

最终候选的场景批次共记录 19 次执行。其中一次修复已获得定位提议，却因 3.5 秒条件等待不足而阻塞；另三次在后台初始页面 30 秒加载超时，尚未到达目标测试步骤。后续分离定位失败等待与状态条件等待，延长页面加载等待，并将仅检查适用性的场景放到同源轻量页面上，再针对失败项重跑。它们是新建的虚构任务，不是对不确定提交的自动恢复。

四次失败仍保留在 [第一组路径执行](artifacts/final-path/summary.json)和[第一组反例执行](artifacts/final-negatives/summary.json)中。后续证据见[修复与适用性重跑](artifacts/repair-retry/summary.json)、[停止重跑](artifacts/stop-retry/summary.json)和[修复步骤范围验证](artifacts/step-scope-check/summary.json)。较早的候选生成、准备和校准失败不属于这 19 次，也完整保留在 `artifacts/`。

归纳过程暴露了比超时更重要的问题：

- [初次整体生成](artifacts/initial-candidate/)曾将结构化引用写成字符串；格式检查拒绝了结果覆盖不足的提议。随后格式正确的候选仍不代表条件正确。
- [加入真实状态后的候选](artifacts/grounded-candidate/)把编辑器条件放在后台入口阶段，实际执行即被阻塞。[下一次候选](artifacts/revised-candidate/)又依赖短暂的上传通知等不稳定状态。
- [整体修订提议](artifacts/persistent-conditions/answer.json)出现错误步骤索引与阶段混淆，未直接作为最终候选。
- [三项小提议](artifacts/focused-candidate/)提供了标题位置、上传状态和发布面板定位，但上传条件仍抄写样本文件名，部分定位缺少完整格式。实验程序把期望值改为当前素材引用、展开格式，并组合回已有路径；[组合记录](artifacts/focused-bound-candidate/assembly.json)明确记录了这些辅助修正。

全部真实模型调用共 11 次、229,282 tokens，包含失败提议和失败运行。候选生成及修订占 8 次、221,298 tokens；执行期间修复占 3 次、7,984 tokens。大段观察记录输入的开销明显高于最后的三项小提议，但该样本不足以证明更小提议普遍更准确或更省。调用明细见 [证据索引](artifacts/evidence-index.json)。

## 对设计的影响与尚未验证的保证

建议保留一个统一执行 Interface：接收固定任务输入与授权、候选流程、绑定页面和停止信号；负责参数绑定、条件检查、有限动作执行、修复约束与结果核对；返回完成、阻塞、结果不确定、需要参与或已停止及其证据。网页字段知识和业务步骤留在候选数据中，通用程序解释检查原语。本实验已有记录导入候选、复用与修复共用的接口，完整的首次逐步探路循环仍待接入验证。

本轮不冻结最终 JSON、复杂分支语言或浏览器组合，也不把候选能执行等同于归纳正确。以下边界继续保留：

- 任务类型、授权来源、输入槽位、动作效果分类和部分组合规则由测试提供。语义相近任务的自动适用性判断、无需人工修订的归纳及校准归入[新建验证事项](../../issues/15-autonomous-workflow-induction.md)。尤其不能允许仅把提交动作标为读取，就绕过必要检查。
- 栏目反例证明可观察的目标状态改变可以被发现；没有证明能发现 DOM 相同而服务器含义改变、未知副作用或检查后的竞态。同源检查也不等于完整的账号或租户授权绑定。
- 提交派发后的失败返回结果不确定，未取得网站侧恰好一次的保证。重复提交判定与恢复由[提交中断后的实际结果判定](../../issues/08-result-recovery-evidence.md)继续验证。
- 停止样本是程序信号，未冒充真人输入。已进入浏览器内部的动作取消、双页归属及人工接管，继续结合[独立停止](../../issues/02-independent-stop.md)、[AI 双页操作归属](../../issues/06-ai-parallel-binding.md)和[人工接管](../../issues/12-human-input-takeover.md)证据。
- 版本写入原子性与并发修复、真实内容预览与发布绑定、第二后台泛化仍需各自验证。这里的新版复用启动了新浏览器，但没有新增跨 Node 进程的证据；此前实验的冷启动结论保持原有限定。

可依据本轮结果收敛执行器的责任，同时把自动归纳作为下一项核心验证。若仍须人工修订才能得到正确候选，就应记录为产品能力缺口，不能在实现规格中写成已成立的自动学习能力。
