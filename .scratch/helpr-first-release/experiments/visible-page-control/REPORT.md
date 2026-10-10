# 页面归属、并行与输入来源：实验记录

日期：2026-10-10。状态：**自动实验与 Electron 真人对照已完成，用户确认显示完整且没有串页。Chromium 真人输入未验证。实验实例已关闭。**

本记录保存 [验证真实网页的页面归属、并行与输入来源](../../issues/01-visible-page-control.md)的实验事实。它不选择最终浏览器组合，也不表示人工接管或完整产品已经成立。

## 环境与重跑入口

| 项目 | 实际值 |
| --- | --- |
| 操作系统 | macOS 14.8.3，arm64 |
| 实验驱动 | Node.js 24.18.0，Playwright 1.64.0 |
| Electron | 44.7.0，内置 Chromium 152.0.7977.130、Node.js 24.21.0 |
| 普通 Chromium | Chrome for Testing 156.0.8078.4，Playwright build 1248 |
| Electron 会话 | 独立 userData 目录中的默认 session；关闭后台节流 |
| Electron 连接 | `_electron.launch()` 管理启动与主进程；网页动作使用外部 `connectOverCDP({ noDefaults: true })` |
| Chromium 连接 | 可见的持久浏览器上下文，独立 userDataDir，加载仅匹配本地测试站点的实验扩展 |
| 测试内容 | 本机回环地址上的独立网页和短暂延迟的计数接口；没有真实账号、模型调用或业务发布 |

运行步骤见 [README](README.md)。源码、依赖锁定和当前运行输出均位于本目录。

主要证据：

- [自动实验结果](artifacts/2026-10-10T08-43-43-263Z/results.json)：18 项检查的原始结果；其中两项原始失败保留。
- [针对性复核](artifacts/2026-10-10T08-43-43-263Z/follow-up.json)：修正浮窗目标选择后的成功结果，以及确认原生窗口已最小化后的双页操作。
- [页面、扩展与测试服务器事件](artifacts/2026-10-10T08-43-43-263Z/events.jsonl)。
- [Electron 宿主事件](artifacts/2026-10-10T08-43-43-263Z/electron-native.jsonl)。
- [Electron 页面画面](artifacts/2026-10-10T08-43-43-263Z/electron-A.png)与 [Chromium 页面画面](artifacts/2026-10-10T08-43-43-263Z/chromium-A.png)。这些截图证明页面内容可观察；它们不替代用户对实际窗口的查看。
- [重新打开后的 Electron 真人证据](artifacts/manual-2026-10-10T09-05-47-329Z/human-evidence.json)：用户反馈、最终页面快照、中文输入法、粘贴和宿主事件计数。
- [真人轮次的页面事件](artifacts/manual-2026-10-10T09-05-47-329Z/events.jsonl)、[宿主事件](artifacts/manual-2026-10-10T09-05-47-329Z/electron-native.jsonl)及 [汇总](artifacts/manual-2026-10-10T09-05-47-329Z/summary.json)。自动预检查与 `human-ready` 之后的真人样本分开记录。
- [完成入口的刷新、导航、滚动检查](artifacts/manual-2026-10-10T09-05-47-329Z/results.json)和 [修正后的页面画面](artifacts/manual-2026-10-10T09-05-47-329Z/electron-A-ready.png)。

## 页面身份和操作归属

**Electron 外部 CDP 与 Chromium 扩展路径均能区分相同 URL 的两个页面。**

Electron 两个测试视图的 WebContents ID 分别为 2、3，CDP target ID 不同，且 `webContents.fromDevToolsTargetId()` 能回查对应对象。通过另一条外部 CDP 连接修改 B 的输入后，原控制连接读到同一内容。测试页分别保存自己的计数和输入，未出现操作串页。

Chromium 实验扩展从消息发送方取得 tabId，再通过 `chrome.debugger.getTargets()` 对照 CDP target ID；两者一致。两个相同 URL 的标签页仍能被独立定位，不依赖当前活动页或 URL 唯一性。

两种路径都完成了同 origin 导航、从 `127.0.0.1` 到 `localhost` 的跨 origin 导航，以及由 A 打开的弹窗。导航后的 target ID 保持不变，弹窗的 openerId 指向 A，弹窗计数操作成功。此结果不覆盖任意站点的弹窗登录、受限页面或复杂跨域 frame。

## 实际重叠与后台条件

两项任务分别点击真实页面中的按钮；按钮等待测试服务器响应后才增加计数。每轮两页各连续执行 3 次，服务器记录请求处理区间。`overlaps` 表示一次操作开始时另一页的操作仍未结束，不能用仅启动两个脚本替代这一证据。

| 条件 | A / B 计数变化 | 观察到的跨页重叠开始次数 |
| --- | --- | --- |
| Electron 并排显示 | 各 +3 | 3 |
| Electron 仅显示 A、B 留在后台 | 各 +3 | 2 |
| Electron 窗口被实验覆盖窗口遮挡 | 各 +3 | 1 |
| Electron 窗口最小化 | 各 +3 | 1 |
| Chromium 后台标签页 | 各 +3 | 4 |
| Chromium 窗口最小化 | 各 +3 | 3 |
| Chromium 窗口被实验覆盖窗口遮挡 | 各 +3 | 3 |

Electron 后台一轮的宿主显示模式始终为 A，系统指针前后坐标均为 `(874, 11)`；Chromium 后台一轮的活动 tabId 前后相同。这是当前样本没有切走显示页或移动系统指针的证据，不是任意网站与任意输入场景的保证。

Chromium 最小化另做了一次针对性复核：通过 `Browser.getWindowBounds` 确认 `windowState=minimized` 后，两页仍各完成一次计数。与此同时两个文档仍报告 `visibility=visible`、`focused=true`。因此不能把这些 DOM 值作为用户正在查看页面或准备接管的证明。

## 自动输入来源的实测反例

| 自动操作 | 观察到的行为 | 对来源判断的限制 |
| --- | --- | --- |
| Playwright 点击 | DOM pointer/click 为 `isTrusted=true`；Electron `before-mouse-event` 与 `input-event` 都触发 | trusted 与宿主鼠标钩子的存在均不能独立代表真人 |
| Playwright 字符键输入 | DOM key/input 为 trusted；Electron `input-event` 有记录，而此样本未触发 `before-input-event` | 与下述真人样本存在差异，但不能由某一通道的差异推广出完整来源规则 |
| 直接插入中文、fill | 产生 trusted 的 beforeinput/input，可没有逐字符 key 事件 | 键盘事件数量不是输入来源或输入完整性的可靠替代 |
| 页面脚本 click / dispatchEvent | click 为 `isTrusted=false` | 能识别这一类脚本派发，不能覆盖全部自动化通道 |
| Electron sendInputEvent | 可触发 `before-input-event`、`before-mouse-event` 和 DOM 事件 | 即便键盘钩子触发，也不能直接推广成真人标记 |
| 自动滚动和滚动后点击 | 可产生 wheel、scroll 类活动与 trusted 点击 | 滚动或查看不能被直接当作接管意图 |

这些操作的 `stage` 是实验驱动已知来源的标注，不是产品可读取的浏览器来源字段。部分键盘记录包含版本相关的 `_modifiers` 数值，本实验没有把未公开承诺的字段当作稳定接口。

普通 Chromium 的 content script 同样能记录 trusted 自动点击、键盘与输入事件。扩展处于隔离脚本环境，不因此得到物理输入证明。上述结果已经否定“只判断 isTrusted”或“只监听宿主鼠标钩子”的简单方案；可靠识别机制交由 [人工接管的输入识别与让出操作](../../issues/12-human-input-takeover.md)继续验证。

## 浮窗与业务页面

Electron 的说明浮窗属于独立 WebContents，向浮窗输入不会修改 A 的业务输入框。首轮完整运行中的浮窗检查仍使用 `_electron.windows()`，未找到目标；修正实验脚本，统一使用已验证的外部 CDP 页面集合后，针对性复核通过。

Chromium 浮窗由 content script 插入业务页面 DOM，向其中输入没有改变业务输入框，但输入事件会被该网页的事件观察者看到。实验用 `inOverlay` 标明自己的浮窗控件；未来的观察与动作边界需要显式处理这些控件，不能仅凭 content script 的脚本隔离假设它们与业务页面隔离。

## 连接边界和实验准备问题

- 当前应用结构和启动顺序下，`_electron.windows()` 的页面发现不完整。默认 session 也复现，不能归因于自定义 partition；外部 CDP 则能枚举并控制实际视图。官方存在 WebContentsView 支持测试，但不能据此覆盖本次运行中的相反观察。这里尚未定位到可普遍复现的上游根因，不把它写成 Electron 或 Playwright 全面不支持。[官方测试](https://github.com/microsoft/playwright/blob/v1.64.0/tests/electron/electron-webcontentsview.spec.ts)
- Electron 首次下载超过原来的启动超时，已将二进制准备放到启动测量前。Playwright 对应 Chromium 尚未安装时也有一次准备失败；安装指定 build 后完成 Chromium 实验。这两次属于实验准备，不能作为承载能力失败。
- 本次外部 CDP 与 `_electron` 同时连接。独立启动、完全不经过 `_electron` 初始化的运行方式，以及不同 session/partition 的发现、登录状态和隔离，仍需在相关组合选择中验证。

## 真人对照

原先请用户对两套候选重复操作，但没有先解释比较目的。用户提出“为什么需要再 Chrome for Testing 中操作？”后，本轮收敛为 Electron 的真人对照；Chromium 保留自动证据，真人输入明确记为未验证，后续确有选型需要时再补。

第一次输入中，两段目标文字都来自粘贴，之后收到实际输入法样本。用户随后报告完成按钮不存在：读取实际页面确认已进入 `/next`，新文档默认隐藏真人说明区域，导致按钮也隐藏。已修正实验页，将入口移至页面上方并随滚动保持可见，同时保存同 origin 页面中的真人模式。用户退出实例并明确要求重来后，使用独立 `manual.mjs` 重新打开 Electron；原始记录保留，最终反馈对应重新打开后的轮次。

2026-10-10 05:06—05:07（America/New_York；原始日志使用 UTC），用户按清单完成查看、切换 A/B、点击、中文输入法、复制粘贴与浮窗输入，并明确回复：**“已完成，显示完整且没有串页”。** 记录与反馈一致：

| 项目 | 记录 |
| --- | --- |
| A 页面计数与输入 | 计数为 1；中文输入为“手动接管测试”，粘贴框为“网页输入验证 2026” |
| B 页面 | 计数仍为 0；两处输入保持空白；与 A 使用不同的 target ID |
| 中文输入法 | 3 段 composition，依次提交“手动”“接管”“测试”；23 次 `insertCompositionText` 输入 |
| 复制粘贴 | 有 paste 与 `insertFromPaste` 记录；内容与样本一致 |
| 独立浮窗 | 最终内容为“对话测试”；业务页输入未被替换 |
| 完成记录 | 上方按钮产生 `human-done` 快照；同时具有用户在对话中的明确反馈 |

本机这次真人中文输入法序列还有两项重要观察：3 个 `compositionend` 的 `isTrusted=false`，其前面的 composition/input 为 trusted；对应键入区间有 23 个宿主 `input-event:rawKeyDown` 和 23 个 `before-input-event:keyUp`，但没有 `before-input-event:keyDown`。因此，不能把 trusted 的真假直接映射为人工或程序，也不能只依赖键盘按下钩子覆盖中文输入。此处是特定环境的实测序列，没有把差异原因推定为某个输入法或浏览器的普遍行为。

真人观察、移动鼠标与切换页面的样本已取得，但实验没有接入接管判定器，不能据此宣称“不会误接管”。`stage`、宿主 marker 和用户反馈用于确认实验过程；它们不是产品可用的来源信号。

## 实验页修复与剩余问题

完成入口在刷新、进入 `/next` 及滚动后保持可见的检查已通过。最早的独立浏览器复核仅验证了显示和滚动，当时记录仍在 `/fixture`，不将它视为导航通过；最终证据采用 Electron 真人重开前的明确 `/next` 检查。重开驱动还增加了等待两页加载并绑定任务后再连接 CDP，避免准备阶段漏发现页面；失败尝试单独保留于 `artifacts/manual-2026-10-10T09-05-04-757Z/`。

本次取得了候选承载的页面与输入事实。独立停止、人工与自动输入同时发生时的让出操作、迟到模型回复、流程复用和中断恢复仍由相应事项验证；最终承载选型必须等待 [人工接管机制](../../issues/12-human-input-takeover.md)等依赖完成。
