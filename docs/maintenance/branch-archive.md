# 分支归档索引

2026-10-16，按用户“帮我合理的处理所有分支”整理。正式实现已合入 `main`；原型和研究报告继续作为独立来源保存，不合并为产品代码，也不因归档改变原型确认或验收结论。

## 当前入口

- `main`：正式规格、已确认决定及产品实现，跟踪 `origin/main`，也是 GitHub 默认分支。
- `codex/core-workspace-prototype`：仍需回看的 01–04 原型，保留本地分支和工作副本。其当前源码另有远程归档标签备份；本机预览入口仍在原目录。
- `codex/recovery-prototype`：2026-10-17 新增的 05 状态演示，版本 `recovery-v1`，固定来源 `5a75723b480ec88215e74de00d08c3e57346129f`，尚待体验确认。活动副本为 `/Users/yuexiaoliang/.codex/worktrees/recovery-prototype/helpr`，入口为其中的 `.scratch/helpr-first-release-implementation/prototypes/recovery/recovery-prototype.html`，可直接双击；临时预览在 `http://127.0.0.1:4318/recovery-prototype.html`。本轮仅本机保存分支与提交，没有新增远程归档标签。
- 其它已结束的分支由下表的附注标签保留。删除旧分支名不删除源码或报告；后续引用使用归档标签或完整提交，不依赖已经删除的分支名。
- `codex/lifecycle-prototype`：06 状态演示 `lifecycle-v1`，固定来源 `980141ccde93fbddda48c371abe0a7d26dd4936c`。用户于2026-10-19明确确认，06于2026-10-20完成十条验收；原型仍作为独立一手来源保留，不合并为产品代码。2026-10-20用户确认可删除旧副本后，已用Git正常移除干净的工作副本及登记，来源分支与提交保留；旧路径 `/Users/yuexiaoliang/.codex/worktrees/lifecycle-prototype/helpr` 已不存在，临时4319预览也已停止。本地分支及完整提交保留，没有新增远程归档标签。

早期状态原型与凭据研究的旧工作副本已切换到对应归档标签，处于 detached HEAD，不再占用开发分支；也已提交 Codex 工作副本归档请求。归档来源与恢复不依赖这些本机目录是否继续存在。

## 已保留的来源

所有标签均已推送到 `origin`，并核对其指向的原始提交。

| 原分支                                            | 原始提交                                   | 归档标签                                                                                                                                          | 处理依据                                                                              |
| ------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `codex/installable-task-workspace`                | `c5df35ffa0ff4e995d5bf779d35a8ef50a8bea2d` | [`archive/2026-10-16/installable-task-workspace`](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-16/installable-task-workspace)       | 已完整合入 `main`，清理本地旧分支；此标签也是 build 22 对应的源码快照。               |
| `codex/core-workspace-prototype`                  | `f47b2579a93ca581e643bcd328b15974352fd1fd` | [`archive/2026-10-16/core-workspace-prototype`](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-16/core-workspace-prototype)           | 01–04 已确认设计的一手资料，保留活动工作副本；标签固定本次整理时的版本。              |
| `codex/participation-state-prototype`             | `7d335bcbab09811804391d28c1d000de68eae9cd` | [`archive/2026-10-16/participation-state-prototype`](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-16/participation-state-prototype) | 已确认的停止与继续等决定已写入主分支；原型独立归档，清理本地旧分支。                  |
| `codex/research-unattended-update-credentials`    | `ccf081717c50cbb17621810e7709cd077fe09b2e` | [`archive/2026-10-16/unattended-update-credentials`](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-16/unattended-update-credentials) | 自动安装已移出首版；报告供后续签名、更新工作回看，清理本地及远程旧分支。              |
| `research/helpr-model-configuration`              | `4fab6200cc1f0477a3c7189ae473ea7852c2d5c8` | [`archive/2026-10-16/model-configuration`](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-16/model-configuration)                     | 接入结论及后续验证已在主分支；原始报告独立归档，清理本地及远程旧分支。                |
| `research/helpr-second-backend`（原先仅远程存在） | `c52232537c9024955c1cf15d33f3ca1fd54bf560` | [`archive/2026-10-16/second-validation-backend`](https://github.com/yuexiaoliang/helpr/tree/archive/2026-10-16/second-validation-backend)         | 独立历史只包含第二后台调研；Drupal 的选择与部署证据已在主分支，归档后清理远程旧分支。 |

## 回看与恢复

上表链接可以直接查看全部原始文件。需要本地恢复时，先取得标签，再创建独立工作副本；不将原型或报告合并进 `main`。

```sh
git fetch origin 'refs/tags/archive/*:refs/tags/archive/*'
git worktree add --detach ../helpr-participation-archive archive/2026-10-16/participation-state-prototype
```

状态原型的入口是新工作副本中的 `.scratch/helpr-first-release/prototypes/participation-state-prototype.html`，可直接打开。其它来源替换标签和目标目录即可；归档标签不随后续开发移动。

整理前另已制作并验证本机完整 Git 备份：`.local/branch-cleanup/2026-10-16/helpr-before-branch-cleanup.bundle`。它不进入版本库；可用 `git bundle verify` 检查，必要时从中取得整理前的分支。核心原型工作副本中的未跟踪预览日志保留在原处。


## 06 完成后的原型恢复

06已通过[最终验收](../testing/evidence/lifecycle-06/FINAL-ACCEPTANCE.md)。其原型分支仍固定在`980141ccde93fbddda48c371abe0a7d26dd4936c`；工作副本归档不删除Git来源。旧副本已移除，原型源码可随时基于保留提交创建独立副本：

```sh
git worktree add --detach ../helpr-lifecycle-archive 980141ccde93fbddda48c371abe0a7d26dd4936c
```

入口为新目录中的`.scratch/helpr-first-release-implementation/prototypes/lifecycle/lifecycle-prototype.html`，可直接双击。原型内存状态、模拟系统事件与正式验收仍有原来边界；恢复原型不代表重新运行正式验证。


2026-10-20善后复查：原型工作副本无未提交或忽略文件，来源分支和HTML已核对。两次Codex归档调用均仅返回`queued`，最后检查时目录及活动附件仍在，因此尚未确认归档完成，不手动删除受管目录，也不重复同样请求。应用15PID／3组及旧4319预览端口均已独立确认无残留；详见[收尾状态](../testing/evidence/lifecycle-06/CLOSEOUT.json)。


随后用户确认可以删除旧副本：再次核对无未提交、未跟踪或忽略文件，`codex/lifecycle-prototype`仍指向上述原提交。以`git worktree remove`正常移除副本，独立确认目录不存在、Git只剩主工作区，HTML仍可由保留分支读取。Codex接口仍列出旧附件元数据，未把它当作目录仍在或归档已成功；未修改应用内部元数据。
