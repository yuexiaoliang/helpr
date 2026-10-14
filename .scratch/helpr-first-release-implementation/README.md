# helpr 首版实现事项

2026-10-13，用户确认“按这 23 项发布正式事项”。本目录已按确认的颗粒度与依赖发布 23 个独立事项，依据为已提交的[首版实现规格](../helpr-first-release/spec.md)（`d649263`）；[已批准拆分与规格覆盖表](breakdown.md)保留拆分依据。

发布时尚未开始产品实现。全部事项的 `Status: ready-for-agent` 表示范围与验收要求已明确，不表示原型已获批准、前置事项已完成或产品已通过验收。2026-10-14，用户已确认[01 可安装的双任务真实工作区](issues/01-installable-task-workspace.md#原型确认)所记录的 `foundation-v2` 交互与布局，并选定第 4 款无竖线标签栏；当前 `foundation-v3` 原型来源为 `b4ea509`。正式产品实现尚未开始，其它事项仍分别核对原型覆盖与确认。

23 项均遵循[原型确认与实现](../../docs/agents/issue-tracker.md#原型确认与实现)。规格与拆分的批准保留其原意；各功能取得对应原型确认后，才进入正式实现。

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
