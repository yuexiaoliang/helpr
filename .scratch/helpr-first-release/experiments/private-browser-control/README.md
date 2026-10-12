# 浏览器控制连接与宿主隔离

一次决策用的本机实验。先读 [报告](REPORT.md) 和[预算方案](PLAN.md)。最终保留版本通过 43 项检查，前四轮的失败与修订全部保留。

只读复核：

```sh
node .scratch/helpr-first-release/experiments/private-browser-control/verify.mjs
```

实验入口是 `run.mjs`，实际会开启 Electron 窗口、创建本机网页和子进程；它不是产品启动入口。依赖沿用相邻 `visible-page-control/node_modules` 中固定的 Electron 44.7.0 和 Playwright 1.64.0。源码快照记录在每轮 artifacts 中；前期快照中有已知缺陷，不作为可用版本。

预算 8 次启动，本轮实际 5 次；没有为凑满预算继续运行。`evidence-index.json` 固定已有证据，校验器不会生成或改写结果。若另行扩展场景，先说明新范围、冻结新版本并保留旧记录，不能覆盖已有运行或把本轮通过外推到新的协议能力。

提交时忽略每轮 `profile/`：其中包含浏览器运行缓存和会话数据，不作为可移植证据。历史索引仍保留当时的文件摘要，但只读复核仅要求并读取其余 189 份归档文件；在没有 profile 的检出目录中也可核对。该调整没有改变候选源码、场景结果或原始摘要。
