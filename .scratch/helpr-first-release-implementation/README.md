# helpr 首版实现事项

2026-10-13，用户确认“按这 23 项发布正式事项”。本目录按确认的颗粒度与依赖发布 23 个独立事项，原始依据为[首版实现规格](../helpr-first-release/spec.md)（`d649263`）；[已批准拆分与规格覆盖表](breakdown.md)保留拆分依据。2026-10-14，已将 `33f6eab` 中确认的[工程技术栈方案](engineering-stack-proposal.md)和 ADR-0005 同步进当前规格及本组事项，数量、直接依赖和产品范围保持。

全部事项的 `Status: ready-for-agent` 表示范围与验收要求已明确，不表示原型已获批准、前置事项已完成或产品已通过验收。2026-10-14，用户已确认[01 可安装的双任务真实工作区](issues/01-installable-task-workspace.md#原型确认)所记录的 `foundation-v2` 交互与布局，并选定第 4 款无竖线标签栏；当前 `foundation-v3` 原型来源为 `b4ea509`。技术规划与规格同步已提交，用户再次调用 implement 恢复 01 实现；实际工作区、记录与工程检查已有进展，退出残留修正、双页隔离、加密会话、冷重开与故障恢复的实包自动核对通过；用户已确认网页与浮窗可见，手动登录、输入法和最终交互仍待验收，详见[核对报告](../../docs/testing/evidence/workspace-01/REPORT.md)。其它事项仍分别核对前置完成、原型覆盖与确认。

23 项均遵循[原型确认与实现](../../docs/agents/issue-tracker.md#原型确认与实现)。规格与拆分的批准保留其原意；各功能取得对应原型确认后，才进入正式实现。

原型与研究来源的当前入口、固定提交和恢复方式见[分支归档索引](../../docs/maintenance/branch-archive.md)。核心工作区原型继续保留活动工作副本；已结束的来源以远程标签保存，不将模拟或历史调研并入正式产品代码。

原规划事项 01–26 仍保存在首版规划目录，记录已解决的设计问题；本目录重新从 01 编号，记录待实现的产品行为。两套编号不可混用，父规格与原规划事项保持原状。

## 事项与直接依赖

只列真正阻塞本项的直接前置。选择所有前置都已完成的事项推进，不要求前面的全部编号都完成；没有依赖也不代表自动创建代理或新对话。

| 实现事项 | 必须先完成 |
| --- | --- |
| [01 可安装的双任务真实工作区](issues/01-installable-task-workspace.md) | 无 |
| [02 配置模型并在所属任务理解网页](issues/02-model-settings-and-page-understanding.md) | [01](issues/01-installable-task-workspace.md) |
| [03 两项网页任务执行、停止与继续](issues/03-parallel-execution-stop-and-continue.md) | [02](issues/02-model-settings-and-page-understanding.md) |
| [04 直接接管网页与页面变化后的归属](issues/04-native-takeover-and-page-ownership.md) | [03](issues/03-parallel-execution-stop-and-continue.md) |
| [05 退出、意外退出与冷重开核对](issues/05-quit-crash-and-cold-recovery.md) | [04](issues/04-native-takeover-and-page-ownership.md) |
| [06 收起运行、锁屏与休眠恢复](issues/06-hide-lock-sleep-and-resume.md) | [05](issues/05-quit-crash-and-cold-recovery.md) |
| [07 本机备份与旧备份恢复](issues/07-local-backup-and-restore.md) | [05](issues/05-quit-crash-and-cold-recovery.md) |
| [08 自动检查新版与可信下载提醒](issues/08-version-check-and-download-notice.md) | [02](issues/02-model-settings-and-page-understanding.md) |
| [09 手动换版保留资料、原密钥和有效登录](issues/09-manual-upgrade-and-credential-continuity.md) | [06](issues/06-hide-lock-sleep-and-resume.md)、[07](issues/07-local-backup-and-restore.md)、[08](issues/08-version-check-and-download-notice.md) |
| [10 参与请求、确认与全局可操作提醒](issues/10-participation-and-actionable-notifications.md) | [03](issues/03-parallel-execution-stop-and-continue.md) |
| [11 任务组、收起、关闭与历史返回](issues/11-task-groups-history-and-close.md) | [04](issues/04-native-takeover-and-page-ownership.md)、[10](issues/10-participation-and-actionable-notifications.md) |
| [12 固定素材版本并准备真实上传](issues/12-material-version-and-upload-preparation.md) | [06](issues/06-hide-lock-sleep-and-resume.md)、[10](issues/10-participation-and-actionable-notifications.md) |
| [13 首次附件发布并保存学到的流程](issues/13-first-publication-and-learned-workflow.md) | [12](issues/12-material-version-and-upload-preparation.md) |
| [14 提交中断后的真实网站结果核对](issues/14-recover-real-publication-outcomes.md) | [13](issues/13-first-publication-and-learned-workflow.md) |
| [15 换输入与冷启动流程复用](issues/15-parameterized-and-cold-workflow-reuse.md) | [13](issues/13-first-publication-and-learned-workflow.md) |
| [16 共享登录与同一目标的执行协调](issues/16-shared-login-and-target-coordination.md) | [13](issues/13-first-publication-and-learned-workflow.md) |
| [17 网页变化修复与并发流程采用](issues/17-page-change-and-concurrent-workflow-repair.md) | [14](issues/14-recover-real-publication-outcomes.md)、[15](issues/15-parameterized-and-cold-workflow-reuse.md)、[16](issues/16-shared-login-and-target-coordination.md) |
| [18 读取 Excel、预览并确认文章](issues/18-excel-article-preview-and-publish.md) | [13](issues/13-first-publication-and-learned-workflow.md) |
| [19 发布约定与素材处理归属](issues/19-publishing-agreements-and-material-work.md) | [18](issues/18-excel-article-preview-and-publish.md) |
| [20 定时选材、旧工作与错过时间处理](issues/20-scheduled-material-work-and-missed-runs.md) | [11](issues/11-task-groups-history-and-close.md)、[14](issues/14-recover-real-publication-outcomes.md)、[16](issues/16-shared-login-and-target-coordination.md)、[19](issues/19-publishing-agreements-and-material-work.md) |
| [21 在 Drupal 学习并完成同样的委托](issues/21-drupal-cross-site-workflow.md) | [15](issues/15-parameterized-and-cold-workflow-reuse.md) |
| [22 历史清理、引用保留与空间不足处理](issues/22-history-cleanup-and-storage-failures.md) | [07](issues/07-local-backup-and-restore.md)、[20](issues/20-scheduled-material-work-and-missed-runs.md) |
| [23 固定交付候选并完成整体验收](issues/23-integrated-release-acceptance.md) | [09](issues/09-manual-upgrade-and-credential-continuity.md)、[17](issues/17-page-change-and-concurrent-workflow-repair.md)、[21](issues/21-drupal-cross-site-workflow.md)、[22](issues/22-history-cleanup-and-storage-failures.md) |

## 工程实现与验证约定

每项的 `Engineering:` 指向本节与已确认选型；详细职责以[当前规格](../helpr-first-release/spec.md#implementation-decisions)和 [ADR-0005](../../docs/adr/0005-record-process-and-state-transitions.md)为准，逐轮选择及备选见[工程评审](engineering-stack-review.md)。本节是全部事项的共同约束，具体能力随其所属事项接入，不要求 01 提前实现全部功能。

- 正式应用采用 TypeScript 严格检查、Zod、React／CSS Modules／按需 React Aria；界面订阅有版本的投影，业务转换由独立记录进程中的 XState 稳定 5.x 计算。网站做法仍是运行时流程数据。
- 独立记录进程用 better-sqlite3 与 Drizzle 保存、迁移和备份；控制拥有者持有即时资格及私有 pipe。开始动作先可靠保存、临近派发再核对；停止先阻断再保存，记录失败或旧回执不能放行新动作。XState 恢复不直接重启网页或模型副作用。
- Electron 原生通信加 Zod 固定业务命令，按真实通道核对身份与角色、任务和版本；远程网页、工作者及界面均不得绕过规定能力。原生输入在网页宿主的 AppKit 线程识别，因果次序须由组合验证证明。
- pnpm 管理一个应用、一个产品锁文件及必要的本地原生包；固定 Node、pnpm 和精确兼容依赖，保留默认隔离布局与明确构建许可。electron-vite 显式多入口、electron-builder 稳定 v26 和 node-gyp 形成实际包；主机测试不能代替内嵌运行时、生产依赖、资源与受限 preload 的验证。
- 正式检查使用 Vitest、React Testing Library、类型检查、类型化 ESLint／React Hooks、现成模块边界规则及 Prettier，沿用三组公开行为入口。旧实验保留，升级独立进行并复验受影响能力；最终验收正常启动实际产物，不为测试放宽隔离或重开裸调试端口。
- AI SDK Core 显式直连服务，关闭隐式重试与自主网页执行；每次发送重新核对并记账，原始用量缺失保持未知。Pino／pino-roll 只保存限定字段的本机诊断，各进程独占文件；诊断轮转、失败与业务历史和可靠保存分别管理。

| 要求的主要承接位置 | 具体交付与验证 |
| --- | --- |
| 01；后续所有事项沿用 | 锁定兼容组合，迁移旧候选，贯通 React 工作区、受限通信、独立记录、受控观察和实际包；验证干净冻结安装、包内原生依赖、冷重开、界面归属与本机诊断。先取得启动、切换及双页资源测量。 |
| 02–03；后续模型与执行路径沿用 | 本机服务独立核对实际请求、取消、重试与未知用量；独立记录进程的慢盘、保存失败、回执丢失和迟到不绕过控制资格。双任务执行经同一入口并保留独立效果证据。 |
| 04–06；23 复验 | 原生识别、实际阻断、网页收件及自动动作效果的先后关系；控制／记录／网页宿主和工作者的退出、恢复、锁屏与休眠组合。03–06 补齐双任务与持续运行测量，按首个贯通包冻结性能门槛。 |
| 07、09；新增资料随对应事项扩充 | 记录进程协调数据库快照及外部引用文件，冻结迁移和状态模型版本，验证备份、迁移失败及中断保留；两个真实版本核对原凭据与有效登录。 |
| 10–17、19、21 | 复用已选状态、通信、模型与执行入口扩展业务；状态投影不授予权限，学习、复用与修复不增设网站专用代码或 SDK 执行旁路。 |
| 18、20 | 在对应功能原型中，以代表性文件及时间表达选择成熟解析／时间库并锁定支持边界；不预选候选库，也不减少原定功能范围。 |
| 22–23 | 区分诊断轮转与业务资料清理；固定产品依赖及许可证清单，复验组合、已冻结性能门槛及完整交付条件。 |

这些要求不新建工程前置事项、不改变原型确认记录，也不新增模型、网页写入、构建、安装、故障或真人运行额度。当前只更新文档；恢复实现须遵循用户后续明确指令。

## 跨事项完成约定

- 每项都在同一正式应用中形成可演示或独立核验的完整行为，包含所需界面、记录、执行和检查。实现前阅读[产品访谈](../../docs/product/discovery.md)、[术语表](../../GLOSSARY.md)、[相关架构决定](../../docs/adr/)及本事项引用的规格与依据；不默认继承旧版项目的产品或架构。
- 验证使用规格中已确认的三组公开入口：意图、记录与派发；网页工作区、执行与流程；应用运行、版本检查与资料恢复。需要持久化的事实同步覆盖重复调用、归属、中断与保存失败，适用行为随本项接入日常检查。
- 新动作仍经过统一资格与控制入口。停止、人工接管、待参与和未知结果的规则不能被后续流程或定时触发绕过；后续新增流程、素材、约定与计划时，同时扩展备份、迁移、清理和恢复检查。
- 受控页面、模型回应和故障注入只证明对应边界。真实理解、流程学习、网页结果及素材字节分别取证，独立核验的答案不得提供给产品。既有实验保留失败和适用范围，不能直接充抵完整产品通过。
- 06 集中首轮真人输入与系统生命周期核对，23 完成第二轮，每轮预计 10–15 分钟主动操作。由 agent 先确认安装包、可见窗口、页面绘制、进度、焦点与记录采集，再一次提供一个动作和停止位置；真实中文输入法、⌘V、锁屏与休眠不能用自动输入替代。必要的安装、登录和系统授权另记。
- 09 及早验证当时已有资料的真实手动换版，20 增补计划与升级准备的竞争，23 在固定交付候选中复验完整资料。恢复原密钥与未过期登录必须有实际证据，重新输入密钥或重新登录不充抵延续成功。
- 每批真实运行先固定候选、账号／目标、案例、模型与费用、网页写入、构建安装、故障及时间上限，沿用已有有效授权。失败、准备失败和修后重跑累计，重启不清零，不重启已结束实验。结果不明、越界、停止失效、关键保存失败、凭据保护失败、异常弹窗或自有进程残留时，停止受影响验证并保存现场；在已有范围内完成必要修正，超出授权的消耗另给具体增量方案。
- 首版面向用户当前 Mac 自用，保留只读新版检查和手动下载安装。正式签名与公证在首次对外测试或发布前办理；自动下载安装留待盈利后。本次发布事项不启动模型调用、远程发布、安装实验、签名购买或系统设置更改。
- 源码、事项和脱敏证据按仓库约定保存；密钥、证书私钥、浏览器资料、运行时数据库和构建产物遵守 ignore。不能把敏感运行资料作为验收附件提交。

## 完成记录与后续推进

实现时逐项勾选通过的验收条件，并在各事项 `Comments` 中记录实现提交、公开入口检查、独立证据、实际消耗、失败与修正，以及尚未覆盖的范围。只有该事项的验收全部完成，前置交付才算满足；不能仅凭分诊状态或代码已写好解除后续阻塞。需要人工行为或真实网站证据的条件不能用本机模拟检查替代。

完成后从表中选择所有前置均已满足的下一项，先核对该项的原型确认记录，再推进相应阶段。新增反例若影响已完成依赖，应明确受影响范围并补做必要检查；不通过删除原失败、换样本或缩小既定保证把事项判为完成。

23 汇总的是同一固定交付候选的完整验收：五项业务各两次、三种探索／复用并行组合、完整矩阵、真人核对与实际手动升级，不能以早期局部成功代替。

## Comments

2026-10-13，按用户明确批准发布。23 项标题、数量和直接依赖与已批准拆分一致；未修改父规格或规划事项，未启动实现或新一轮实验。

2026-10-14，按用户新确立的开发流程，为全部事项增加原型确认前置要求。保留原分诊状态、功能范围与事项依赖；尚未取得适用原型确认的功能继续处于实现准备阶段。

2026-10-14，按用户调用 to-spec 的请求，同步已提交的工程选型、进程职责和验证要求。全部事项增加共同工程依据，适用事项补充实施约束与验收证据；保留原 23 项、直接依赖、66 项故事覆盖和已取得的原型确认。没有恢复实现或启动验证运行，兼容版本与性能数值仍待实际证据确定。

2026-10-15，当前推进 [02 的交互原型](issues/02-model-settings-and-page-understanding.md#原型确认)，版本 `model-understanding-v1`，等待确认；原型制作先于正式实现，不因 01 尚有整体交付检查而追加安装或桌面复验，也不把 01 全项记为完成。本阶段只走查原型的主要交互，真实实现后的检查按受影响范围安排，完整组合与交付条件仍在所属阶段核对。

2026-10-15，用户随后回复“可以”，[02 原型确认](issues/02-model-settings-and-page-understanding.md#原型确认)已取得，正式实现以 `model-understanding-v1`（`a722b68`）覆盖范围为依据；本次只登记确认，不把模拟演示当作真实能力通过。

2026-10-15，02 正式代码及最小实际试用已提交为 `cd2effd`、`20eead6`、`62f5001`：两张网页真实问答各自正确，用户确认 B 回答及切回 A 保留。用户随后要求继续推进，当前准备 [03 执行、停止与继续原型](issues/03-parallel-execution-stop-and-continue.md#原型确认)，版本 `execution-v1`，待体验确认；正式网页操作尚未开始。本轮不重复 01／02 已接受的操作，也不将其余整体验收条件提前勾选。

2026-10-16，用户体验 03 后明确回复“验收通过”，已确认 [execution-v1（c3592fb）](issues/03-parallel-execution-stop-and-continue.md#原型确认)，按此前 implement 授权进入已确认范围的正式开发；原型通过与真实功能证据分别记录。

2026-10-16，03 源码及限定真实试用已提交（`2b9d739`），用户确认 A 继续后完成、网页次数仍为 1、结果可查看。完整交付缺口保留，不重复已通过人工步骤。用户随后说“继续”，当前准备 [04 直接接管与页面归属原型](issues/04-native-takeover-and-page-ownership.md#原型确认)，版本 `takeover-v1`，待确认；只推进原型，不提前解除依赖或编写正式原生接管代码。

2026-10-16，用户确认“按这一版及所列范围实现”，[04 takeover-v1（b3d6e31）](issues/04-native-takeover-and-page-ownership.md#原型确认)已取得明确同意，按本次指令推进接管、页面归属、即时资格与可靠暂停记录。03 其余组合缺口保留；新功能不由原型或源码检查直接计为完成，真人核对仍按既定集中安排。

2026-10-16，04 复用候选 22 取得点击、键盘、工具粘贴、明确继续与文字保留、刷新、iframe／弹窗归属的[限定实际包证据](../../docs/testing/evidence/takeover-04/PACKAGED-TAKEOVER.md)，没有重复已通过人工步骤。记录写锁未形成预期慢保存重叠，失败及必要清理保留；原生因果、未知归属及其余组合缺口尚未补齐，04 不整体勾选，也不解除 05 前置。真人中文输入法与 ⌘V 仍归 06。
