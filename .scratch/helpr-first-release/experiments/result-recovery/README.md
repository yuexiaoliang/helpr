# 提交中断与实际结果判定实验

一次性决策实验，对应 [验证提交中断后的实际结果判定](../../issues/08-result-recovery-evidence.md)。运行范围见 [计划](PLAN.md)，准备额度变更见 [用户批准记录](AMENDMENT-PROPOSAL.md)，事实与局限见 [报告](REPORT.md)。本目录不提供产品恢复调度器。

## 离线检查

从仓库根目录运行：

```bash
npm run check
npm run test:browser
node .scratch/helpr-first-release/experiments/result-recovery/verify.mjs
```

`record.test.mjs` 核对新进程中的记录、意图、版本及素材一致性；`proxy.test.mjs` 只使用本机 HTTP 夹具，验证 CONNECT、上传预算和扣住回执。`verify.mjs` 读取留存的真实实验产物，不访问网站、登录态或模型。语法检查排除历史源快照。

## 实验装置

- `run.mjs` 管理固定登记、预算、源快照、独立执行进程与 SIGKILL；`status` 只读当前登记。记录在 `private/study.json`，另有可审计的公开镜像。
- `worker.mjs` 使用通用浏览器动作和条件检查。`workflow.json` 是既有流程的原样副本；`recovery-contract.json` 保存本次由操作者校准的页面入口、查找和核对条件。
- `proxy.mjs` 仅用于测试故障和计数，知道测试站点请求格式。恢复进程不能读取它的成功日志，所有恢复请求经过只读代理。浏览器页面本身可能尝试心跳等写请求，代理会拦截并留痕。
- `common.mjs` 在读取前验证执行身份、任务摘要、流程及条件版本、素材字节和记录完整性。内容摘要用于发现不一致，不是对抗恶意篡改的签名。

## 真实运行入口

这些命令会产生测试网站副作用，只在既定预算和对应授权内使用。不能删除登记或另起目录绕过上限；本次新准备和上传额度已经用完。

```bash
node .scratch/helpr-first-release/experiments/result-recovery/run.mjs status
node .scratch/helpr-first-release/experiments/result-recovery/run.mjs pair A5 B5
node .scratch/helpr-first-release/experiments/result-recovery/run.mjs recover A5 recovered
node .scratch/helpr-first-release/experiments/result-recovery/run.mjs recover B5 foreign-result from=A5/recovered
node .scratch/helpr-first-release/experiments/result-recovery/run.mjs recover A5 hidden-result hide
node .scratch/helpr-first-release/experiments/result-recovery/run.mjs recover A5 verified-crash result-verified
node .scratch/helpr-first-release/experiments/result-recovery/run.mjs intent B5 stopped
node .scratch/helpr-first-release/experiments/result-recovery/run.mjs resume B5 continued observed
```

相同输出目录拒绝覆盖。`intent` 是实验夹具设置持久化意图，不代表真人输入来源验证。只有 `running` 能进入执行；恢复只报告判断，不自动调用 `resume`。

`recheck-preparation A4 dispatch-gap dispatch-gap` 仅复用原失败准备实际保存的草稿：从失败观察取网页地址，重新打开并核对所有内容，再继续同一执行到指定中断点。它不新增任务、不重复上传、不改写原失败证据，不是产品自动修复功能。

登录态复用 `runtime-flow-replay/private/auth.json`，不纳入 Git。真实运行复用该实验安装的 Playwright，版本锁及共享执行器源码均随本次证据快照保存。
