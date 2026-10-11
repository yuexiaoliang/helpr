# 真实 AI 双页归属实验

对应 [验证可见工作区中的 AI 双页操作归属](../../issues/06-ai-parallel-binding.md)。这是取得选型证据的一次性实验，不是产品执行器。

候选组合：`deepseek-flash` 的封闭动作提议 + 独立 Node.js 执行进程 + Playwright 1.64.0 外部 CDP，分别接入 Electron 44.7.0 的双 `WebContentsView` 和 Chromium 双标签页。Chromium 同时加载只读身份扩展，核对 `tabId` 与 CDP target；Electron 核对 `webContents.id` 与 target。模型、浏览器请求和服务器操作均真实运行，网页业务是本机合成夹具。停止、切换查看、错误和队列延迟由实验程序注入，不冒充真人接管。Stagehand 不在本轮组合内。

## 预先固定的范围

- 两个相同 URL 页面同时探索，模型分别看自己的页面；后续才出现弹窗表单，两页提交在服务器真实重叠，最后核对文字、弹窗和回复归属。
- 切换查看不改变任务路由；导航后保持 target 身份。
- 取消正在等待按钮的动作及连续输入；在执行子进程排队、重试等待、真实模型回复迟到时停止；旧执行回复不能借用新执行。
- 真实模型请求取消、单任务页面错误、故意篡改成另一个任务的页面目标。独立 B 的真实模型循环继续完成。
- 每个浏览器原语都在实际派发进程检查执行身份并接收独立取消信号；页面、服务器和消息日志共同核对。

**预算在首个模型请求前固定：40 分钟、96 次调用、150,000 tokens，最多 6 次程序修订。** 时间从首次运行开始计；修订及失败保留原始证据，不重置总调用或用量。两种宿主共 18 个场景；每个自动探索循环最多 8 次提议，不无限重试。模型客户端沿用已有配置，凭据不复制到证据中。

实际首轮因维护者误判进度并重复运行，耗尽 96 次调用。随后对尚缺的五个 Chromium 场景单独登记了 [补测计划](artifacts/chromium-missing-cases/PLAN.json)，上限为 10 分钟、18 次调用、30,000 tokens、零协议修订，实际使用 17 次调用。两轮合计 113 次调用；不声称全部验证在原先 96 次上限内完成。完整过程见 [实验报告](REPORT.md)。

## 重跑

先按相邻 `independent-stop/README.md` 准备锁定的 Electron、Playwright 依赖与 Chromium。本实验直接使用其依赖，以及 `model-api/client.mjs` 和已有本机配置。

```sh
cd .scratch/helpr-first-release/experiments/ai-parallel-binding
node run.mjs
```

隔离窗口会自动打开并关闭；网站只监听回环地址。`artifacts/<时间>/` 保存版本、模型输入输出、控制与服务器事件、截图和逐项断言。浏览器配置目录忽略提交。

向 `run.mjs` 传入已有证据目录可续跑；已通过且执行协议一致的场景会跳过，原预算继续生效。加 `--plan` 只列出剩余场景和预算，不打开浏览器、不调用模型。存在 `PLAN.json` 时沿用其中限定的宿主与场景；也可用 `HOST_FILTER`、`CASE_FILTER` 收窄本轮范围。

```sh
node run.mjs artifacts/chromium-missing-cases --plan
node verify.mjs
```

`verify.mjs` 独立读取本次固定证据集，检查模型观察的页面归属、实际派发和停止顺序、服务器结果、调用重叠、协议源码一致性及只读续跑计划，生成 [证据索引](evidence-index.json)。此复查不产生模型调用。当前驱动的续跑和预算前置检查在实测结束后补齐；18 项实测使用各目录保存的源码版本。

`node verify.mjs --check` 仅校验，保留证据索引原样；它和 `--plan` 均无需安装浏览器依赖。仓库根目录的 `npm run check` 和 [CI](../../../../.github/workflows/check.yml) 已接入此入口。运行失误与待改进的预算、状态和续跑边界见 [本轮复盘](RETRO.md)。

只对受控网页和本轮单原语集合形成结论；不证明共享登录冲突、业务后台并行、任意第三方代理内部动作或生产恢复能力。
