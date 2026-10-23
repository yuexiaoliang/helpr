# 分支归档索引

2026-10-16完成首轮分支整理；2026-10-20按用户“没用的分支就删掉吧”继续清理。正式规格与产品实现保留在`main`，原型和研究源码通过归档标签独立保存，不合并为产品代码，不因删除分支名改变原型确认或验收结论。

## 当前入口

- 2026-10-20清理时，本地和远端均只保留`main`。2026-10-23新增本地`codex/backup-prototype`及活动工作副本，保留已确认的07原型；未推送该分支，详见[当前入口](#07-当前备份恢复原型)。
- 原型源码使用下表归档标签回看。旧分支名、4317／4318／4319临时预览和已移除的本机路径不再作为当前入口；事项中的原体验记录保留历史含义。
- 01–04原型使用`archive/2026-10-16/core-workspace-prototype`，05使用`archive/2026-10-20/recovery-prototype`，06使用`archive/2026-10-20/lifecycle-prototype`。
- 本次只推送05、06两个新增归档标签，没有推送`main`中的本地实现提交。
- 2026-10-23新增08的本地`codex/version-check-prototype`及本聊天附属工作副本，版本待确认；[当前入口](#08-当前新版检查原型)独立保留，未推送或合入产品。

## 已保留的来源

下表归档标签均已推送到`origin`，并核对远端标签解引用后的原始提交。05的标签同时保留`recovery-v1`源码提交`5a75723b480ec88215e74de00d08c3e57346129f`及随后确认记录。

| 原分支 | 已保留提交 | 归档标签 | 处理依据 |
| --- | --- | --- | --- |
| `codex/installable-task-workspace` | `c5df35ffa0ff4e995d5bf779d35a8ef50a8bea2d` | [archive/2026-10-16/installable-task-workspace](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-16/installable-task-workspace) | 已完整合入main，标签也是build22源码快照；旧分支已清理 |
| `codex/core-workspace-prototype` | `f47b2579a93ca581e643bcd328b15974352fd1fd` | [archive/2026-10-16/core-workspace-prototype](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-16/core-workspace-prototype) | 01–04已确认原型的一手来源；2026-10-20清理旧分支名 |
| `codex/recovery-prototype` | `5b39a74f97b3bc68d6d7d400eb5284fd2cdc438c` | [archive/2026-10-20/recovery-prototype](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-20/recovery-prototype) | 05已验收，源码和确认记录保存后清理分支名 |
| `codex/lifecycle-prototype` | `980141ccde93fbddda48c371abe0a7d26dd4936c` | [archive/2026-10-20/lifecycle-prototype](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-20/lifecycle-prototype) | 06十条验收完成，副本已移除，原型保存后清理分支名 |
| `codex/participation-state-prototype` | `7d335bcbab09811804391d28c1d000de68eae9cd` | [archive/2026-10-16/participation-state-prototype](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-16/participation-state-prototype) | 停止与继续等决定已写入main，原型独立归档 |
| `codex/research-unattended-update-credentials` | `ccf081717c50cbb17621810e7709cd077fe09b2e` | [archive/2026-10-16/unattended-update-credentials](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-16/unattended-update-credentials) | 自动安装移出首版，保留调研供后续回看 |
| `research/helpr-model-configuration` | `4fab6200cc1f0477a3c7189ae473ea7852c2d5c8` | [archive/2026-10-16/model-configuration](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-16/model-configuration) | 接入结论已落地，原始报告独立归档 |
| `research/helpr-second-backend` | `c52232537c9024955c1cf15d33f3ca1fd54bf560` | [archive/2026-10-16/second-validation-backend](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-16/second-validation-backend) | Drupal选择与部署证据已落地，原始调研归档 |

## 回看与恢复

归档标签保留原始提交及其祖先，不随后续开发移动。需要恢复时取得标签，再创建独立副本；不要把原型或研究报告合并进main。

```sh
git fetch origin 'refs/tags/archive/*:refs/tags/archive/*'
git worktree add --detach ../helpr-lifecycle-archive archive/2026-10-20/lifecycle-prototype
```

06入口位于新目录的`.scratch/helpr-first-release-implementation/prototypes/lifecycle/lifecycle-prototype.html`，可直接双击。05替换标签为`archive/2026-10-20/recovery-prototype`，入口为`prototypes/recovery/recovery-prototype.html`；01–04使用核心工作区标签及`prototypes/core-workspace/`内原HTML与素材。

2026-10-16整理前的本机完整Git备份仍按原记录保留在`.local/branch-cleanup/2026-10-16/helpr-before-branch-cleanup.bundle`，可用`git bundle verify`检查。2026-10-20的[分支清理记录](branch-cleanup-2026-10-20.json)保存删除前提交、对应归档标签与远端核对结果。

## 06副本清理与旧附件记录

06已通过[最终验收](../testing/evidence/lifecycle-06/FINAL-ACCEPTANCE.md)。其原型副本先尝试Codex归档，两次均只返回queued且目录未移除；随后用户确认删除，核对副本无未提交、未跟踪或忽略文件后，用Git正常移除副本与工作区登记。原应用15PID／3组及旧4319预览端口均无残留。

旧路径`/Users/yuexiaoliang/.codex/worktrees/lifecycle-prototype/helpr`已不存在。Codex接口仍列出旧附件元数据，不能据此认定目录仍在，也不能称原生归档已成功；未修改应用内部元数据。源码现由远端归档标签保留，恢复方式见上文。[收尾状态](../testing/evidence/lifecycle-06/CLOSEOUT.json)区分磁盘／Git清理与附件元数据状态。

## 07 当前备份恢复原型

2026-10-23按用户请求新增`backup-v1`，来源分支`codex/backup-prototype`，固定源码`9bca8026274eb0358a84a88397a3068cb053c82e`。用户已明确确认，产品实现独立编写并已进入验收；原型仍独立保留，尚未归档，不合入产品。

- 工作副本：`/Users/yuexiaoliang/.codex/worktrees/backup-prototype/helpr`。
- [单文件入口](/Users/yuexiaoliang/.codex/worktrees/backup-prototype/helpr/.scratch/helpr-first-release-implementation/prototypes/backup/backup-prototype.html)，可直接双击；[范围与走查说明](/Users/yuexiaoliang/.codex/worktrees/backup-prototype/helpr/.scratch/helpr-first-release-implementation/prototypes/backup/README.md)。
- 原临时内置浏览器预览已结束，原型单文件保留。
- [07事项](../../.scratch/helpr-first-release-implementation/issues/07-local-backup-and-restore.md#原型确认)记录已确认范围与实现／验收状态。若以后移除副本，可从上述固定提交以Git恢复`.scratch/helpr-first-release-implementation/prototypes/backup/`，不依赖临时服务。

本次主工作区只登记来源和范围，不合入原型HTML或其模拟逻辑。历史归档标签及05／06验收结论保持。

## 08 当前新版检查原型

2026-10-23按用户“那就做吧”制作`version-check-v1`，来源分支`codex/version-check-prototype`，固定源码`23d3ecdbc345f31e44decdc3516260213b9c57c2`。当前待用户体验并明确确认，没有开始08正式实现。

- 工作副本：`/Users/yuexiaoliang/.codex/worktrees/version-check-prototype/helpr`，本聊天附属的受管工作区。
- [单文件入口](/Users/yuexiaoliang/.codex/worktrees/version-check-prototype/helpr/.scratch/helpr-first-release-implementation/prototypes/version-check/version-check-prototype.html)，可直接双击；[范围与走查说明](/Users/yuexiaoliang/.codex/worktrees/version-check-prototype/helpr/.scratch/helpr-first-release-implementation/prototypes/version-check/README.md)。
- 内置浏览器临时预览使用`http://127.0.0.1:4320/version-check-prototype.html`，本机服务在2026-10-23约16:34（Asia/Shanghai）独立到期；到期不影响HTML。
- [08事项](../../.scratch/helpr-first-release-implementation/issues/08-version-check-and-download-notice.md#原型确认)列出拟确认范围，包括拟议检查频率、当前会话稍后处理和各种异常；12场景／69分步及修正证据只保存在原型分支。
- 原型所有网络、下载和任务均为模拟；版本与下载来源仍待正式实现时确定。没有把原型合入主工作区产品代码，也没有推送分支或新标签。以后移除副本时，可从固定提交恢复`.scratch/helpr-first-release-implementation/prototypes/version-check/`。
