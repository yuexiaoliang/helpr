# 可见网页工作区的承载边界

调查日期：2026-10-10（America/New_York）。本轮为只读调查，未安装依赖、运行实验、登录账号或编写产品代码。

前提是本轮已确定的“真实网页为主体 + 对话浮窗”、本机执行，以及通用产品能力与运行时流程分离；本记录不选择最终架构，也不把旧版实现当作约束。参见[产品访谈](../product/discovery.md)、[ADR-0001](../adr/0001-local-execution.md)、[ADR-0002](../adr/0002-runtime-workflows.md)。浏览器库的基础能力另见[已有调查](browser-execution-primitives.md)。

文中“事实”表示官方文档或源码直接支持；“推论”表示基于这些事实的工程判断；“待验证”表示尚无本项目实测。源码证据使用 Playwright `v1.64.0`；Stagehand 使用 v4 文档，其 npm `latest` 本轮查询为 `4.2.0`，扩展源码另明确固定到调查时的 `main` 提交，不能视为已核对该 npm 包的全部内容。[Playwright 源码标签](https://github.com/microsoft/playwright/tree/v1.64.0)、[Stagehand npm 元数据](https://registry.npmjs.org/@browserbasehq%2fstagehand/latest)

## 已查明的关键边界

- **事实：WebContentsView 可以进入 Playwright 的页面集合。** 官方测试使用一个 `BaseWindow` 放置三个 `WebContentsView`，断言 `firstWindow()` 和 `windows()` 能发现它们。这证明已有上游支持证据；没有证明 helpr 的浮窗、登录、文件操作和人工接管已经成立。[官方测试](https://github.com/microsoft/playwright/blob/v1.64.0/tests/electron/electron-webcontentsview.spec.ts)、[测试应用](https://github.com/microsoft/playwright/blob/v1.64.0/tests/electron/electron-webcontentsview-app.js)
- **事实与未知：Stagehand v4 需要浏览器扩展运行时；Electron 对该运行时的兼容性尚未确认。** 有 CDP 接口并不足以推出二者直接兼容，具体缺口见下文。[Stagehand 浏览器配置](https://docs.stagehand.dev/v4/configuration/browser#connecting-over-cdp)、[Electron 扩展支持范围](https://www.electronjs.org/docs/latest/api/extensions)
- **事实：`isTrusted` 不是人工输入标识。** Playwright 官方测试明确断言程序调用 `page.mouse.click()` 产生的点击为 `isTrusted=true`；Chromium 实现使用 `Input.dispatchMouseEvent`。因此页面或扩展不能用这个字段把人工点击与 CDP 点击可靠分开。[鼠标测试](https://github.com/microsoft/playwright/blob/v1.64.0/tests/page/page-mouse.spec.ts#L25-L52)、[Chromium 输入实现](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/src/server/chromium/crInput.ts#L105-L165)

## 两种承载方式显示的是什么

| 方面 | Electron WebContentsView | 普通 Chromium 页面 + 扩展浮窗 |
| --- | --- | --- |
| 真实网页 | **事实：**视图展示独立的 `WebContents`，可加载 URL，并加入窗口的原生视图树；同一个 `WebContents` 同时只能由一个 `WebContentsView` 展示。[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) | **事实：**content script 在浏览器访问的网页中运行，可读取、修改该网页 DOM；真实页面仍是原标签页。[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) |
| 浮窗的可能实现边界 | **事实：**原生 `View` 支持设置位置、大小和子视图顺序。**推论：**可以由另一个视图承载对话层，但层叠不是目标页面内部的 CSS `z-index` 问题；透明区域、焦点与点击穿透仍需实验。官方还明确圆角裁掉的区域仍会捕获点击。[View](https://www.electronjs.org/docs/latest/api/view) | **事实：**content script 的 JavaScript 默认处于隔离环境，但能改变页面 DOM。**推论：**可以插入浮窗；这种变量隔离不等于浮窗在布局、截图或可访问性树中自动与业务页分离。[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#work-in-isolated-worlds) |
| 页面覆盖范围 | **事实：**应用持有具体 `WebContents`，可通过其引用及 CDP target ID 关联页面。[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)、[fromDevToolsTargetId](https://www.electronjs.org/docs/latest/api/web-contents#webcontentsfromdevtoolstargetidtargetid) | **事实：**注入受 URL 匹配、host permissions 或临时 `activeTab` 授权约束；跨来源导航会撤销 `activeTab`，它也不授权 `chrome://` 等受限页面。对子 frame 的注入需要匹配相应 frame。[脚本注入](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#inject-programmatically)、[activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)、[frame 范围](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#specify-frames) |

**待验证：**网页刷新、跨域跳转、登录弹窗、全屏、缩放、拖动浮窗和输入法使用时，对话层是否持续可用；浮窗是否挡住目标元素，是否被 AI 观察误认为业务控件。两种承载方式都不能仅凭“浮窗能显示”宣布这些行为成立。

## Playwright 和 Stagehand 如何操作同一网页

### Electron 路径

**事实：**Playwright 的 `_electron.launch()` 属于实验性 Electron 支持；WebContentsView 的发现有前述官方测试。它是“由 Playwright 启动应用”的现成路径，不代表任意运行中的 Electron 应用已经自动暴露同样接口。[Playwright Electron](https://playwright.dev/docs/api/class-electron)、[WebContentsView 测试](https://github.com/microsoft/playwright/blob/v1.64.0/tests/electron/electron-webcontentsview.spec.ts)

**事实：**Electron 支持 `--remote-debugging-port`；另有 `webContents.debugger` 作为向指定 WebContents 发送 CDP 命令的接口。Playwright `chromium.connectOverCDP()` 接受 Chromium 浏览器的 HTTP/WebSocket 调试端点，但官方明确其完整性低于 Playwright 自身协议，外部启动参数也可能影响功能。[Electron 调试端口](https://www.electronjs.org/docs/latest/api/command-line-switches#--remote-debugging-portport)、[Electron Debugger](https://www.electronjs.org/docs/latest/api/debugger)、[Playwright connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)

**推论与待验证：**外部执行器连接 Electron 调试端口、选中同一 WebContentsView，是有接口依据的候选路径。需实测目标枚举、不同 session partition、导航后身份关联及文件操作；`webContents.debugger` 对象本身不是可直接传给 `connectOverCDP()` 的 WebSocket 端点。若改用自建协议转接，便是 helpr 需要承担的通用集成工作，不能记作库开箱即用的事实。

**事实：**Stagehand v4 的 `localBrowser.connect()` 经 DevTools 端点连接 Chromium，寻找或加载 Stagehand 扩展；SDK 需连接承载运行时的扩展 service worker，文档要求 `--enable-unsafe-extension-debugging`。调查时源码中的扩展为 Manifest V3，并声明 `debugger`、`offscreen`、`scripting`、`tabs` 权限和模块 service worker。[Stagehand 配置](https://docs.stagehand.dev/v4/configuration/browser)、[扩展 manifest，固定提交 1fc8849](https://github.com/browserbase/stagehand/blob/1fc884992b68a0196ea5c6e96cc29924b0922ef4/packages/extension/manifest.json)

**事实：**Electron 只承诺部分 Chrome 扩展 API，并明确不以任意 Chrome 扩展完全兼容为目标；其列出的支持项没有 `chrome.debugger`、`chrome.offscreen`，`background` 明列为 Manifest V2。扩展只可加载到持久 session，且重启后须重新加载。[Electron 扩展支持](https://www.electronjs.org/docs/latest/api/extensions)

**推论：**这些差异使“Stagehand v4 直接用于 Electron WebContentsView”成为优先排除兼容性问题的实验，而非已成立的组合。未列入支持项并不能单独证明所有版本都运行失败；本轮也没有找到官方对该组合的兼容承诺或实际运行结果。

### 普通 Chromium 路径

**事实：**Playwright 可启动可见的 Chromium，也可经 CDP 连接已运行实例；Stagehand v4 则提供本机浏览器启动和 CDP 连接路径。两者可各自连接同一浏览器；Stagehand 官方同时指出，独立 CDP 会话不会隔离页面、cookie、导航或请求拦截的写操作，也没有自动协调冲突。[Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype)、[Stagehand 本机配置](https://docs.stagehand.dev/v4/configuration/browser)、[官方对共同连接的说明](https://www.browserbase.com/blog/stagehand-v4)

**事实：**Chrome 扩展另可使用 `chrome.debugger` 直接向标签页发送部分 CDP 域的命令，需要 `debugger` 权限。此接口是另一种传输，文档没有把它定义为 Playwright 的浏览器 WebSocket 端点。[Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)

**推论：**“安装了对话浮窗扩展”与“本机执行器已能控制该标签页”是两件事。采用上述库的现成连接方式，仍须准备浏览器连接条件，并绑定浮窗、执行器和用户当前看到的同一页面。若希望仅安装扩展就连接任意已打开的日常浏览器，需要另行核实通用桥接，不能从 `chrome.debugger` 能发命令直接推出 Playwright/Stagehand 已兼容该桥接。

**事实：**Chrome 从 136 开始，不再对默认用户数据目录接受 `--remote-debugging-port` / `--remote-debugging-pipe`，要求配合非默认 `--user-data-dir`；官方另说明 Chrome for Testing 保持原行为。此限制针对这里的调试开关路径，不能外推为所有扩展都不能访问日常标签页。[Chrome 官方变更](https://developer.chrome.com/blog/remote-debugging-port)

## 登录持久化与可见性

| 问题 | 查明的事实及其含义 |
| --- | --- |
| Electron 登录状态放在哪里 | `session.fromPartition('persist:…')` 创建持久 session，同一 partition 的页面共享它；不带 `persist:` 则在内存中。**推论：**用户可在该会话的真实页面完成登录，再供执行复用；不能因此声称已复用用户日常 Chrome 的登录，也不能保证站点登录永不过期。[Electron Session 官方源码文档](https://github.com/electron/electron/blob/main/docs/api/session.md#sessionfrompartitionpartition-options) |
| Chromium 登录状态放在哪里 | 用户数据目录保存 cookie、local storage 等；同一目录不能同时启动多个浏览器实例。Stagehand 本机配置也提供 `userDataDir`。**推论：**同一个已运行的浏览器可以承载用户与执行器的共同会话，重启复用需固定目录并实际验证站点状态。[Playwright 持久上下文](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)、[Stagehand 配置](https://docs.stagehand.dev/v4/configuration/browser) |
| 视图/标签页“可见”是否证明用户正在看 | Electron `getVisible()` 只表示应绘制，可能仍被遮挡；Chrome tab 的 `active` 也不保证其窗口有焦点。**推论：**二者都不能作为“用户已查看结果”或“用户正在接管”的证据。[Electron View](https://www.electronjs.org/docs/latest/api/view#viewgetvisible)、[Chrome Tab.active](https://developer.chrome.com/docs/extensions/reference/api/tabs#type-Tab) |
| 自动化连接是否改变页面感知 | Playwright CDP 连接的 `noDefaults: true` 可避免默认上下文上的焦点模拟、下载和媒体模拟覆盖；默认值为 `false`。**推论：**页面报告的焦点状态可能受连接设置影响，不能单独识别用户行为。[connectOverCDP 的 noDefaults](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp-option-no-defaults) |

**待验证：**启动和重启后登录是否保留、多个账号/任务是否正确隔离、用户手动完成登录后执行器是否读到同一状态；目标页切后台、窗口被覆盖或最小化后，截图、观察与操作分别有何表现。这里验证的是同一会话与页面身份，不要求读取真实用户账号来完成技术预研。

## 人工操作、仅查看/滚动与接管

**事实：**DOM 标准中 `isTrusted` 表示事件由用户代理派发还是由脚本 `dispatchEvent()` 派发，不是“人还是程序”的证明；脚本 `.click()` 是标准明确的非 trusted 特例。前述 Playwright 测试与 CDP 实现进一步给出了自动点击仍为 trusted 的反例。也不能反向声称所有自动化方法都一定产生 trusted 事件。[DOM Standard](https://dom.spec.whatwg.org/#dom-event-istrusted)、[Playwright 鼠标测试](https://github.com/microsoft/playwright/blob/v1.64.0/tests/page/page-mouse.spec.ts#L25-L52)、[CDP 输入实现](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/src/server/chromium/crInput.ts)

**事实：**Electron 有 `before-input-event` 和 `before-mouse-event`，可在相应页面事件前调用 `preventDefault()`；公开输入结构记录类型、键值、坐标、按钮及修饰键，没有承诺一个稳定的“物理输入/自动化输入”字段。Electron 也提供程序化的 `sendInputEvent()`。[输入拦截事件](https://www.electronjs.org/docs/latest/api/web-contents#event-before-input-event)、[MouseInputEvent](https://www.electronjs.org/docs/latest/api/structures/mouse-input-event)、[InputEvent](https://www.electronjs.org/docs/latest/api/structures/input-event)、[sendInputEvent](https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent)

**未知：**选定 Electron 版本和操作系统上，物理输入、CDP 输入与 `sendInputEvent()` 是否经过完全相同的主进程钩子、顺序和字段；触控板、输入法、粘贴和原生弹窗是否覆盖。不能在实测前把这些钩子当作可靠的人工操作检测器。

**事实：**Playwright 点击默认会在需要时滚动目标到视口内；其 `mouse.wheel()` 在 Chromium 也发送 CDP 输入。**推论：**出现 `scroll`/`wheel` 不等于用户想接管，滚动还可能来自自动定位。仅查看没有接管意图信号；即使明确是用户滚动，也只证明视口变化，没有证明用户要接手任务。[Locator.click](https://playwright.dev/docs/api/class-locator#locator-click)、[Chromium wheel 实现](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/src/server/chromium/crInput.ts#L157-L165)

**推论：**要区分“查看/滚动”和“接管”，helpr 需要自己维护是否继续派发自动化动作的控制状态，以及重新观察页面的时机。记录已发出的动作有助于关联事件，但按时间窗口过滤“自己的事件”只是启发式，不能保证并发输入归因。产品访谈现已确定：用户直接点击或输入时接管，仅移动鼠标或查看内容不接管；这一意图不能由 `isTrusted`、焦点或鼠标移动代替，具体输入识别机制仍待验证。helpr 自己的对话与控件也须验证不会被执行器当作业务页操作目标。

**事实与边界：**Playwright 部分操作接受 `AbortSignal`；这是取消操作的原语。**推论：**接管后防止排队动作或重试继续落到页面，需要 helpr 的调度配合；取消、断开调试连接或隐藏页面都不能被解释成已撤销发出的提交请求或服务端业务结果。[Locator.click 的 signal](https://playwright.dev/docs/api/class-locator#locator-click-option-signal)、[既有停止边界调查](browser-execution-primitives.md)

## 最小实验矩阵（均未执行）

这些实验用于验证当前资料中的缺口，不预设最终承载方式；素材与页面均可使用独立测试环境。

| 实验 | 必须观察的证据 |
| --- | --- |
| WebContentsView 与执行器确为同页 | 分别核查 `_electron.launch()` 和外部 CDP 连接；人工填入内容后自动化读取，自动化改变后在可见视图核对；记录 target、WebContents、session 身份，包含重复 URL 与导航。 |
| Stagehand v4 能否在 Electron 工作 | 固定具体版本，核查扩展加载、service worker、`debugger`/`offscreen`、目标枚举；成功后才尝试一次观察及无业务副作用操作。若失败，记录具体不支持点，不靠“同为 Chromium”继续假设。 |
| Chromium 扩展与两个库共用标签页 | 在非默认持久目录中，浮窗、Playwright、Stagehand 依次操作同一页；验证不误选另一个相同 URL 标签页，连接/断开不改变意图之外的焦点或关闭用户页面。 |
| 输入归因 | 对比真实鼠标/键盘/触控板、Playwright/CDP、Stagehand、Electron `sendInputEvent()`、页面 `dispatchEvent()`；记录主进程钩子和 DOM 事件，不只记录 `isTrusted`。覆盖中文输入法与粘贴。 |
| 查看/滚动与接管竞争 | 比较用户仅看、手动滚动、自动滚动、点击业务控件、输入对话、明确接管/停止；在待发动作、进行中动作和重试边界观察是否还有新动作落地。结果不能把已提交业务宣称为撤销。 |
| 浮窗、页面可见性与观察结果 | 验证遮挡、缩放、窗口切换、最小化、全屏、跨域 frame 与登录弹窗；同时检查用户看到的目标、自动化截图/页面树和实际命中元素是否一致。 |
| 会话持久性 | 用测试账号登录，重启后核对；分别使用 Electron partition 与 Chromium userDataDir，测试关闭视图/标签页、连接重建和账号隔离。 |

本轮资料足以支持对这两种承载方式做小型验证；输入来源识别、Stagehand 与 Electron 的组合兼容性，以及接管时的并发动作处理仍是明确的未验证项。
