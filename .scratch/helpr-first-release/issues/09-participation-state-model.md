# 核对并行执行与用户参与的状态模型

Type: prototype
Label: wayfinder:prototype
Mode: HITL
Status: resolved
Blocked by: None
Map: [helpr 首版技术决策地图](../map.md)

## Question

用可交互的最小状态原型核对：两项任务同时推进时，确认、全局提醒、人工接管、继续、停止、目标修正、收起和重新打开怎样保持各自归属，且符合已确认的用户体验？

依据 [执行与调度建议](../../../docs/product/execution-coordination.md)和 [标签页关闭交互](../../../docs/product/task-tab-close.md)，使用 `prototype` 的逻辑分支，让用户能走过并行、等待、重复回复、迟到回复、登录共同阻碍及恢复等关键情况。

原型从已确认规则出发，仅在具体情境暴露矛盾或缺口时讨论取舍。它不接真实业务，也不作为浏览器操作或并行能力已经通过的证据。

保留状态可见的原型、真人反馈和据此接受的控制关系。原型代码独立保存为实验资产，决定记录在本事项；不把演示 UI 直接认作正式工作区设计。

## Comments

2026-10-11：本轮领取，按 `prototype` 逻辑分支制作了无依赖的单文件演示，包含自由操作与九个引导演练：全局确认、查看与接管、停止与迟到、目标修正、收起、共享登录、中断恢复、定时与容量、过时关闭提示。agent 已逐步点击演练并查看状态变化；这不等于真人接受，也不作为真实网页或恢复能力证据。

原型作为独立资产保存，未合并到主工作目录：

- 分支：`codex/participation-state-prototype`；初版提交：`38b9ed06aeddf0ccb64e7650c62ad88be471b6f2`。
- 分支内文件：`.scratch/helpr-first-release/prototypes/participation-state-prototype.html`，旁有 `participation-state-notes.md` 记录范围与未决项。
- 原型源码：[并行与用户参与状态演练](https://github.com/yuexiaoliang/helpr/blob/7d335bcbab09811804391d28c1d000de68eae9cd/.scratch/helpr-first-release/prototypes/participation-state-prototype.html)；2026-10-16 已归档，原本机目录不再作为长期入口，恢复方式见[归档索引](../../../docs/maintenance/branch-archive.md)。

初版演练暴露一处现有要求尚未明确的行为：用户已经明确停止，之后又对同一任务说“继续”。初版暂按本次结束处理，并在页面标为候选；向用户建议改为“明确继续后先核对已有结果，再续做剩余工作，已完成则告知结果且不重发，无需重新委托”，当时等待真人选择。

2026-10-11：用户选择“明确继续后，先核对再续做（推荐）”。已据此更新原型与产品要求，并增加未完成和结果不明两个引导演练。此次真人反馈确认这一行为取舍；没有将 agent 的演练点击记录为真人体验或接受全部界面的证据。

## Answer

停止后，用户对同一任务发出新的明确“继续”指令，系统先核对已有结果和当前现场，再续做剩余工作；已经完成就告知结果，不重复提交，也无需用户重新委托。结果不确定时保持核对，继续指令不能当作允许直接重试。此选择来自上述真人回答，替代初版原型中“不恢复旧执行”的候选行为。

本轮用具体情境核对了以下控制关系。除停止后的明确继续外，均沿用已确认的产品规则：

| 关系 | 接受的约束 |
| --- | --- |
| 查看与网页操作 | 选中标签页只改变显示；查看、移动鼠标不接管，直接操作网页才让出操作；收起与重新打开不自行恢复执行 |
| 任务与参与请求 | 回复始终属于发起请求的任务、对应执行和当前内容；同组任务分别确认；重复或失效回复不再次生效 |
| 用户意图与实际结果 | 停止立即约束后续派发，已发出的请求仍可能产生结果，须如实记录；停止不能抹掉产出，产出也不能悄悄恢复停止意图 |
| 停止与新的继续 | 新指令允许核对并续做；旧动作、旧模型回复及已失效的问题保持失效；原有内容确认、发布约定与登录条件仍需满足 |
| 共同登录与各自等待 | 共同登录问题可以复用处理入口，恢复登录后分别核对；登录恢复不批准内容，也不自动恢复已停止或人工接管的任务 |
| 重启与恢复 | 原自动执行先核对实际结果；待确认、人工接管和停止的意图保持；无法确认是否已提交时不直接重发 |
| 并行与定时 | 最多两项符合条件的独立任务自动推进；旧一轮待办不覆盖新一轮素材；停止本次执行保留定时计划；新标签页不抢当前查看位置 |
| 关闭提示与最新状态 | 提示出现期间任务已完成时，按最新状态关闭并保留结果，不把过时停止点击应用到其它执行 |

原型现含十一个引导演练及自由操作。初版九个情境已由 agent 逐步点击；本次修改后复查停止与迟到、停止后续做、继续时结果不明、查看与接管、修正与旧确认、共同登录、中断恢复七个相关情境，行为符合上表，浏览器未报告脚本错误。未编写测试套件，未连接真实网页、模型或持久存储；这些记录仅证明模拟演练可用，不证明真实并行、人工输入识别或磁盘恢复能力。

原型保存在 `codex/participation-state-prototype`，最终提交 `7d335bcbab09811804391d28c1d000de68eae9cd`，未合并到产品分支：

- [可交互状态原型源码](https://github.com/yuexiaoliang/helpr/blob/7d335bcbab09811804391d28c1d000de68eae9cd/.scratch/helpr-first-release/prototypes/participation-state-prototype.html)
- [情境、真人反馈与走查边界](https://github.com/yuexiaoliang/helpr/blob/7d335bcbab09811804391d28c1d000de68eae9cd/.scratch/helpr-first-release/prototypes/participation-state-notes.md)

2026-10-16，原型以 `archive/2026-10-16/participation-state-prototype` 标签在远程保留，原提交不变，旧分支不再保留为活动开发分支。详见[分支归档索引](../../../docs/maintenance/branch-archive.md)。归档不改变上述用户决定，也不把模拟演练计作产品验收。

已同步 [产品访谈记录](../../../docs/product/discovery.md)、[产品共识](../../../docs/product/product-agreement.md)、[关闭交互](../../../docs/product/task-tab-close.md)、[执行与调度建议](../../../docs/product/execution-coordination.md)和 [验收范围](../../../docs/product/acceptance-outline.md)。主工作目录只保留经确认的行为与决策资料，原型界面不作为正式工作区设计。

本轮没有新增领域概念或改变既有 ADR。内部执行身份、指令先后、旧动作失效及结果记录的持久化约定，由[确定执行记录、流程更新与定时恢复的约定](10-durable-execution-contract.md)继续确定，不照搬原型字段。素材与预览绑定仍由既有后续事项验证，本次没有新增需要单列的决策。
