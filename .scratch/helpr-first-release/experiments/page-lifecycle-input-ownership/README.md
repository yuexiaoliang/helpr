# 页面变化后的输入归属与继续实验

为[验证页面变化后的输入归属与继续](../../issues/19-page-lifecycle-input-ownership.md)取得选型所需事实。代码是一次性实验候选，不是 helpr 产品实现，也不替代既有真人输入记录。

先读 [REPORT.md](REPORT.md)。原始运行和源码快照位于 [artifacts/](artifacts/)，索引为 [evidence-index.json](artifacts/evidence-index.json)。[PLAN.md](PLAN.md) 保留实验开始时的范围、额度与判定方法。

## 本轮结果

- 旧机制连续两次出现相同失败：页面自行刷新后 A 输入被判成 `unknown`，A、B 一起停止。恢复焦点无效；只重新登记 A 即可恢复正确归属。
- 候选绑定任务的原生外层视图，按宿主登记的 `webContents` 身份找到当前控制页面，并在页面或连接变化后废止旧执行资格。最终完整运行 14 个场景、35 项断言通过，另一次独立启动复验 5 个场景、15 项断言通过。
- 未知归属仍有明确限制：暂停本实验窗口中的两项任务，保留 `unknown-input`，先核对再明确继续。未验证任意网站、popup、渲染进程崩溃或真实休眠唤醒。
- 全部为自动原生探针，新增真人样本为 0。原始键盘事件的 `testInjection: false` 不能单独作为真人依据；同时间戳的原生重送保留在证据中。

## 阅读与离线核对

从仓库根目录运行：

```sh
python3 .scratch/helpr-first-release/experiments/page-lifecycle-input-ownership/audit.py
npm run check
```

`audit.py` 读取源码摘要、预算、检查结果、原生事件和本机服务器收件，写入证据索引。它不启动浏览器，不访问模型或后台；旧版失败必须仍然存在才通过审计。本机若保留原生构建，还会比对其二进制摘要；Git 中不保存这些构建，缺失时仅审计源码和已记录摘要，并在索引中明确标记。

## 运行结构与历史命令

`run.mjs` 在启动前累计记账并冻结源码。`electron.cjs` 提供两个临时回环 HTTP origin、任务视图和对话视图。`native/input-monitor.mm` 只观察实验窗口；其中 `describe` 是保留的诊断接口。`ownership.cjs` 是待选择的输入、页面及继续机制，`cases.cjs` 是独立场景夹具；停止机制只读复用相邻实验的 `independent-stop/control.mjs`。

曾使用以下入口，具体当次源码以各运行的 `source/` 为准：

```sh
node .scratch/helpr-first-release/experiments/page-lifecycle-input-ownership/run.mjs baseline
node .scratch/helpr-first-release/experiments/page-lifecycle-input-ownership/build.mjs
node .scratch/helpr-first-release/experiments/page-lifecycle-input-ownership/run.mjs diagnostic
node .scratch/helpr-first-release/experiments/page-lifecycle-input-ownership/run.mjs candidate
```

最终定向复验通过 `LIFECYCLE_CASES` 选择刷新鼠标、刷新键盘、视图替换、查看切换与对话、核对期间再次停止这 5 个已有场景；完整参数在预算账本中。`explicit: true` 是场景注入的继续意图，不是真人消息。

本轮已关闭：共 6 / 8 次启动、35 / 40 个场景尝试、4 / 4 个实测源码版本，正式运行用时约 20 分钟，模型调用及远端写入均为 0。运行器会拒绝继续消耗或重置这份账本。另开实验时先写新计划并使用独立记录，保留当前失败和结果。

依赖复用 `visible-page-control/node_modules` 中的 Electron / Playwright，以及旧人工接管实验已编译的原生基线；没有新增依赖安装。平台和构建信息见报告。
